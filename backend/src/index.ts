import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EventHub } from "./events.js";
import {
  DisabledAgentProvider,
  LocalPlannerProvider,
  type PlannerProvider,
  RemoteAgentProvider,
  type ScoutProvider,
} from "./providers/agent.js";
import { AgentCoreBrowser } from "./providers/agentcoreBrowser.js";
import { AgentCoreScoutProvider } from "./providers/agentcoreScout.js";
import {
  type CardProvider,
  DisabledCardProvider,
  LocalCardProvider,
  RemoteCardProvider,
} from "./providers/card.js";
import { ChainFundingProvider, DisabledFundingProvider } from "./providers/funding.js";
import { OpenAIPlannerProvider } from "./providers/openaiPlanner.js";
import {
  DisabledPurchaseAgentProvider,
  LocalPurchaseAgentProvider,
  type PurchaseAgentProvider,
  RemotePurchaseAgentProvider,
} from "./providers/purchaseAgent.js";
import { OpenAIScoutBrain, type ScoutBrain, ScriptedScoutBrain } from "./providers/scoutBrain.js";
import { WebSearchScoutBrain } from "./providers/webSearchBrain.js";
import { resolveWikimediaImage } from "./providers/wikimediaImages.js";
import { DynamoRepository } from "./repositories/dynamodb.js";
import { MemoryRepository } from "./repositories/memory.js";
import type { Repository } from "./repository.js";
import { ActivityService } from "./services/activities.js";
import {
  type AuthService,
  CognitoAuthService,
  DisabledAuthService,
  LocalAuthService,
} from "./services/auth.js";
import { PurchaseService } from "./services/purchases.js";
import { WalletAuthService } from "./services/walletAuth.js";
import { WalletFundingService } from "./services/walletFunding.js";
import { FrameHub } from "./streams.js";
import { defaultStreamSecret } from "./streamTokens.js";

const config = loadConfig();
const repository: Repository = createRepository();
const events = new EventHub();
const frames = new FrameHub();
const streamSecret = config.STREAM_TOKEN_SECRET ?? defaultStreamSecret();
const localPlanner = new LocalPlannerProvider({
  callbackBaseUrl: config.PUBLIC_BASE_URL,
  ...(config.AGENT_CALLBACK_TOKEN ? { callbackToken: config.AGENT_CALLBACK_TOKEN } : {}),
});
const remoteAgents = config.AGENT_API_BASE_URL
  ? new RemoteAgentProvider({
      baseUrl: config.AGENT_API_BASE_URL,
      callbackBaseUrl: config.PUBLIC_BASE_URL,
      ...(config.AGENT_API_TOKEN ? { token: config.AGENT_API_TOKEN } : {}),
      ...(config.AGENT_CALLBACK_TOKEN ? { callbackToken: config.AGENT_CALLBACK_TOKEN } : {}),
    })
  : null;
const planner: PlannerProvider =
  config.PLANNER_MODE === "openai" && config.OPENAI_API_KEY
    ? new OpenAIPlannerProvider({
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_MODEL,
        baseUrl: config.OPENAI_BASE_URL,
        callbackBaseUrl: config.PUBLIC_BASE_URL,
        ...(config.AGENT_CALLBACK_TOKEN ? { callbackToken: config.AGENT_CALLBACK_TOKEN } : {}),
      })
    : config.PLANNER_MODE === "remote" && remoteAgents
      ? remoteAgents
      : config.PLANNER_MODE === "local"
        ? localPlanner
        : new DisabledAgentProvider();
// AgentCore is the fallback, not "disabled": a dispatch that answers 503 instead of opening a
// browser is never what we want, and SCOUT_MODE=disabled has to be asked for explicitly.
const scouts: ScoutProvider =
  config.SCOUT_MODE === "remote" && remoteAgents
    ? remoteAgents
    : config.SCOUT_MODE === "disabled"
      ? new DisabledAgentProvider()
      : createAgentCoreScouts();
const cards: CardProvider =
  config.CARD_MODE === "remote" && config.CARD_API_BASE_URL
    ? new RemoteCardProvider({
        baseUrl: config.CARD_API_BASE_URL,
        ...(config.CARD_API_TOKEN ? { token: config.CARD_API_TOKEN } : {}),
      })
    : config.CARD_MODE === "local"
      ? new LocalCardProvider(config.PUBLIC_BASE_URL)
      : new DisabledCardProvider();
const purchaseAgents: PurchaseAgentProvider =
  config.PURCHASE_AGENT_MODE === "remote" && config.PURCHASE_AGENT_API_BASE_URL
    ? new RemotePurchaseAgentProvider({
        baseUrl: config.PURCHASE_AGENT_API_BASE_URL,
        callbackBaseUrl: config.PUBLIC_BASE_URL,
        ...(config.PURCHASE_AGENT_API_TOKEN ? { token: config.PURCHASE_AGENT_API_TOKEN } : {}),
        ...(config.PURCHASE_CALLBACK_TOKEN
          ? { callbackToken: config.PURCHASE_CALLBACK_TOKEN }
          : {}),
      })
    : config.PURCHASE_AGENT_MODE === "local"
      ? new LocalPurchaseAgentProvider({
          callbackBaseUrl: config.PUBLIC_BASE_URL,
          ...(config.PURCHASE_CALLBACK_TOKEN
            ? { callbackToken: config.PURCHASE_CALLBACK_TOKEN }
            : {}),
        })
      : new DisabledPurchaseAgentProvider();
const fundingProvider =
  config.FUNDING_MODE === "chain" &&
  config.HAPPY_WALLET_ADDRESS &&
  config.RPC_URL &&
  config.XSGD_ADDRESS
    ? new ChainFundingProvider({
        walletAddress: config.HAPPY_WALLET_ADDRESS,
        tokenAddress: config.XSGD_ADDRESS,
        tokenDecimals: config.XSGD_DECIMALS,
        chainId: config.CHAIN_ID,
        networkName: config.FUNDING_NETWORK_NAME,
        rpcUrl: config.RPC_URL,
        explorerUrl: config.FUNDING_EXPLORER_URL,
        requiredConfirmations: config.DEPOSIT_CONFIRMATIONS,
      })
    : new DisabledFundingProvider();
const activities = new ActivityService(repository, events, planner, scouts, resolveWikimediaImage);
const purchases = new PurchaseService(repository, events, cards, purchaseAgents, config);
const funding = new WalletFundingService(repository, fundingProvider);
const walletAuth = new WalletAuthService(config.WALLET_AUTH_SECRET);
const auth = createAuthService();
const app = createApp({
  config,
  repository,
  events,
  planner,
  scouts,
  cards,
  purchaseAgents,
  activities,
  purchases,
  funding,
  walletAuth,
  auth,
  frames,
  streamSecret,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(
    `happy-backend http://127.0.0.1:${port} store=${config.DATA_STORE} auth=${auth.mode} planner=${planner.mode} scouts=${scouts.mode} cards=${cards.mode} closer=${purchaseAgents.mode} funding=${fundingProvider.mode}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export { app };

function createAgentCoreScouts(): ScoutProvider {
  /*
   * Discovery runs on web search, not on each shop's own search box. SCOUT_BRAIN=storefront puts
   * the tool-calling brain back if a shop's own index turns out to be the better source.
   */
  const brain: ScoutBrain = !config.OPENAI_API_KEY
    ? new ScriptedScoutBrain()
    : config.SCOUT_BRAIN === "storefront"
      ? new OpenAIScoutBrain({
          apiKey: config.OPENAI_API_KEY,
          model: config.OPENAI_MODEL,
          baseUrl: config.OPENAI_BASE_URL,
          maxToolCalls: config.SCOUT_MAX_TOOL_CALLS,
        })
      : new WebSearchScoutBrain({
          apiKey: config.OPENAI_API_KEY,
          model: config.OPENAI_MODEL,
          baseUrl: config.OPENAI_BASE_URL,
          maxProductOpens: config.SCOUT_MAX_PRODUCT_OPENS,
        });
  return new AgentCoreScoutProvider({
    browser: new AgentCoreBrowser({
      region: config.AWS_REGION,
      browserIdentifier: config.AGENTCORE_BROWSER_ID,
      sessionTimeoutSeconds: config.AGENTCORE_SESSION_TIMEOUT_SECONDS,
      viewport: { width: 900, height: 620 },
      jpegQuality: config.AGENTCORE_JPEG_QUALITY,
      frames,
    }),
    brain,
    callbackBaseUrl: config.PUBLIC_BASE_URL,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    ...(config.AGENT_CALLBACK_TOKEN ? { callbackToken: config.AGENT_CALLBACK_TOKEN } : {}),
    slotsPerItem: config.SCOUT_SLOTS_PER_ITEM,
    maxConcurrentSessions: config.AGENTCORE_MAX_SESSIONS,
    streamSecret,
    // Outlive the browser session the stream belongs to, with slack for a late viewer.
    streamTokenTtlSeconds: config.AGENTCORE_SESSION_TIMEOUT_SECONDS + 300,
    paymentMinMinor: config.PAYMENT_MIN_MINOR,
    paymentMaxMinor: config.PAYMENT_MAX_MINOR,
  });
}

function createRepository(): Repository {
  if (config.DATA_STORE === "memory") return new MemoryRepository();
  if (!config.DYNAMODB_TABLE) {
    throw new Error("DYNAMODB_TABLE is required when DATA_STORE=dynamodb");
  }
  return new DynamoRepository({
    tableName: config.DYNAMODB_TABLE,
    region: config.AWS_REGION,
    ...(config.DYNAMODB_ENDPOINT ? { endpoint: config.DYNAMODB_ENDPOINT } : {}),
  });
}

function createAuthService(): AuthService {
  if (config.AUTH_MODE === "disabled") return new DisabledAuthService();
  if (config.AUTH_MODE === "local") {
    if (!config.AUTH_SESSION_SECRET) throw new Error("AUTH_SESSION_SECRET is required");
    return new LocalAuthService(config.AUTH_SESSION_SECRET);
  }
  if (!config.COGNITO_USER_POOL_ID || !config.COGNITO_CLIENT_ID) {
    throw new Error("Cognito configuration is required when AUTH_MODE=cognito");
  }
  return new CognitoAuthService(
    config.COGNITO_USER_POOL_ID,
    config.COGNITO_CLIENT_ID,
    config.AWS_REGION,
  );
}
