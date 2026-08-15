import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EventHub } from "./events.js";
import {
  DisabledAgentProvider,
  LocalAgentProvider,
  type PlannerProvider,
  RemoteAgentProvider,
  type ScoutProvider,
} from "./providers/agent.js";
import {
  type CardProvider,
  DisabledCardProvider,
  LocalCardProvider,
  RemoteCardProvider,
} from "./providers/card.js";
import { OpenAIPlannerProvider } from "./providers/openaiPlanner.js";
import {
  DisabledPurchaseAgentProvider,
  LocalPurchaseAgentProvider,
  type PurchaseAgentProvider,
  RemotePurchaseAgentProvider,
} from "./providers/purchaseAgent.js";
import { resolveWikimediaImage } from "./providers/wikimediaImages.js";
import { DynamoRepository } from "./repositories/dynamodb.js";
import { MemoryRepository } from "./repositories/memory.js";
import type { Repository } from "./repository.js";
import { ActivityService } from "./services/activities.js";
import { PurchaseService } from "./services/purchases.js";

const config = loadConfig();
const repository: Repository = createRepository();
const events = new EventHub();
const localAgents = new LocalAgentProvider({
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
        ? localAgents
        : new DisabledAgentProvider();
const scouts: ScoutProvider =
  config.SCOUT_MODE === "remote" && remoteAgents
    ? remoteAgents
    : config.SCOUT_MODE === "local"
      ? localAgents
      : new DisabledAgentProvider();
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
const activities = new ActivityService(repository, events, planner, scouts, resolveWikimediaImage);
const purchases = new PurchaseService(repository, events, cards, purchaseAgents, config);
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
});

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(
    `happy-backend http://127.0.0.1:${port} store=${config.DATA_STORE} planner=${planner.mode} scouts=${scouts.mode} cards=${cards.mode} closer=${purchaseAgents.mode}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export { app };

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
