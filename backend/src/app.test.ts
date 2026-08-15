import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import { EventHub } from "./events.js";
import type { AgentProvider } from "./providers/agent.js";
import type { CardProvider, IssueCardRequest, IssuedCard, TopUpResult } from "./providers/card.js";
import type { DepositInspection, FundingProvider } from "./providers/funding.js";
import type {
  PurchaseAgentCancelRequest,
  PurchaseAgentProvider,
  PurchaseAgentRequest,
} from "./providers/purchaseAgent.js";
import { MemoryRepository } from "./repositories/memory.js";
import { ActivityService } from "./services/activities.js";
import type { AuthService, AuthUser } from "./services/auth.js";
import { DisabledAuthService } from "./services/auth.js";
import { PurchaseService } from "./services/purchases.js";
import { WalletAuthService } from "./services/walletAuth.js";
import { WalletFundingService } from "./services/walletFunding.js";
import { FrameHub } from "./streams.js";

const config: Config = {
  PORT: 8787,
  NODE_ENV: "test",
  DATA_STORE: "memory",
  AWS_REGION: "ap-southeast-1",
  FRONTEND_ORIGIN: ["http://localhost:4040"],
  PUBLIC_BASE_URL: "http://localhost:8787",
  AUTH_MODE: "disabled",
  PLANNER_MODE: "remote",
  SCOUT_MODE: "remote",
  ALLOW_MOCK_MONEY: false,
  AGENTCORE_BROWSER_ID: "aws.browser.v1",
  AGENTCORE_SESSION_TIMEOUT_SECONDS: 900,
  AGENTCORE_MAX_SESSIONS: 4,
  AGENTCORE_JPEG_QUALITY: 60,
  SCOUT_SLOTS_PER_ITEM: 2,
  SCOUT_MAX_TOOL_CALLS: 10,
  SCOUT_BRAIN: "websearch",
  SCOUT_MAX_PRODUCT_OPENS: 4,
  OPENAI_MODEL: "gpt-5.6-luna",
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  AGENT_CALLBACK_TOKEN: "callback-secret",
  CARD_MODE: "remote",
  PURCHASE_AGENT_MODE: "remote",
  PURCHASE_CALLBACK_TOKEN: "purchase-callback-secret",
  FUNDING_MODE: "chain",
  HAPPY_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
  CHAIN_ID: 43113,
  RPC_URL: "https://rpc.example",
  XSGD_ADDRESS: "0x2222222222222222222222222222222222222222",
  XSGD_DECIMALS: 6,
  FUNDING_NETWORK_NAME: "Avalanche Fuji C-Chain",
  FUNDING_EXPLORER_URL: "https://explorer.example",
  DEPOSIT_CONFIRMATIONS: 1,
  WALLET_AUTH_SECRET: "test-wallet-auth-secret-that-is-long-enough",
  PAYMENT_MIN_MINOR: 500,
  PAYMENT_MAX_MINOR: 3000,
  PAYMENT_ATTEMPTS_PER_LISTING: 2,
};

class RecordingAgents implements AgentProvider {
  readonly mode = "remote" as const;
  plans = 0;
  searches = 0;

  async startPlanning(): Promise<void> {
    this.plans += 1;
  }
  async dispatchSearch(): Promise<void> {
    this.searches += 1;
  }
  async setSearchPaused(): Promise<void> {}
  async rejectListing(): Promise<void> {}
}

class RecordingCards implements CardProvider {
  readonly mode = "remote" as const;
  async issueCard(_request: IssueCardRequest): Promise<IssuedCard> {
    return {
      cardId: "card-1",
      last4: "1234",
      agentAccess: { revealUrl: "https://cards.example/card-1", token: "secret" },
    };
  }
  async topUp(): Promise<TopUpResult> {
    return { transactionId: "0xtopup", confirmations: 3 };
  }
}

class RecordingPurchaseAgents implements PurchaseAgentProvider {
  readonly mode = "remote" as const;
  async startPurchase(_request: PurchaseAgentRequest): Promise<void> {}
  async cancelPurchase(_request: PurchaseAgentCancelRequest): Promise<void> {}
}

class RecordingFunding implements FundingProvider {
  readonly mode = "chain" as const;
  inspection: DepositInspection = {
    status: "confirmed",
    confirmations: 2,
    amountAtomic: 25_000_000n,
    amountMinor: 2500,
    blockNumber: 123n,
  };

  configuration() {
    return {
      enabled: true as const,
      mode: "chain" as const,
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      tokenSymbol: "XSGD" as const,
      tokenDecimals: 6,
      chainId: 43113,
      networkName: "Avalanche Fuji C-Chain",
      rpcUrl: "https://rpc.example",
      explorerUrl: "https://explorer.example",
      requiredConfirmations: 1,
    };
  }

  async inspectDeposit(): Promise<DepositInspection> {
    return this.inspection;
  }
}

class TestAuth extends DisabledAuthService {
  override async authenticate(): Promise<AuthUser> {
    return {
      id: "test-user",
      email: "test@happy.local",
      name: "Test User",
      initials: "TU",
      createdAt: "2026-08-15T00:00:00.000Z",
    };
  }
}

class HeaderAuth extends DisabledAuthService {
  override async authenticate(authorization: string | undefined): Promise<AuthUser> {
    if (!authorization?.startsWith("Bearer user-")) throw new HttpError(401, "Login required.");
    const id = authorization.slice("Bearer ".length);
    return {
      id,
      email: `${id}@happy.local`,
      name: id,
      initials: id.slice(-1).toUpperCase().padStart(2, "U"),
      createdAt: "2026-08-15T00:00:00.000Z",
    };
  }
}

function harness(auth: AuthService = new TestAuth()) {
  const repository = new MemoryRepository();
  const events = new EventHub();
  const agents = new RecordingAgents();
  const cards = new RecordingCards();
  const purchaseAgents = new RecordingPurchaseAgents();
  const activities = new ActivityService(repository, events, agents, agents);
  const purchases = new PurchaseService(repository, events, cards, purchaseAgents, config);
  const fundingProvider = new RecordingFunding();
  const funding = new WalletFundingService(repository, fundingProvider);
  const walletAuth = new WalletAuthService(config.WALLET_AUTH_SECRET);
  return {
    repository,
    agents,
    fundingProvider,
    app: createApp({
      config,
      repository,
      events,
      planner: agents,
      scouts: agents,
      cards,
      purchaseAgents,
      activities,
      purchases,
      funding,
      walletAuth,
      auth,
      frames: new FrameHub(),
      streamSecret: "test-stream-secret",
    }),
  };
}

const fundingAccount = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);

async function authorizeWallet(app: ReturnType<typeof createApp>): Promise<string> {
  const challengeResponse = await app.request("/v1/wallet/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: fundingAccount.address }),
  });
  const challenge = (await challengeResponse.json()) as {
    challengeToken: string;
    message: string;
  };
  const signature = await fundingAccount.signMessage({ message: challenge.message });
  const verification = await app.request("/v1/wallet/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeToken: challenge.challengeToken, signature }),
  });
  const session = (await verification.json()) as { sessionToken: string };
  return session.sessionToken;
}

describe("Happy backend contract", () => {
  it("requires login and keeps activities scoped to their owner", async () => {
    const { app } = harness(new HeaderAuth());
    expect((await app.request("/v1/activities")).status).toBe(401);

    const createdResponse = await app.request("/v1/activities", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer user-a" },
      body: JSON.stringify({ goal: "buy a private test item" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string };

    const otherList = (await (
      await app.request("/v1/activities", { headers: { authorization: "Bearer user-b" } })
    ).json()) as unknown[];
    expect(otherList).toEqual([]);
    expect(
      (
        await app.request(`/v1/activities/${created.id}`, {
          headers: { authorization: "Bearer user-b" },
        })
      ).status,
    ).toBe(404);
  });

  it("creates a real agent run and accepts authenticated wishlist/live-stream callbacks", async () => {
    const { app, agents } = harness();
    const createdResponse = await app.request("/v1/activities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "buy a keyboard under S$30" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string };
    expect(agents.plans).toBe(1);

    const secondResponse = await app.request("/v1/activities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "buy a mouse while the keyboard activity is still live" }),
    });
    expect(secondResponse.status).toBe(201);
    const second = (await secondResponse.json()) as { id: string };
    expect(second.id).not.toBe(created.id);
    expect(agents.plans).toBe(2);
    const liveActivities = (await (await app.request("/v1/activities")).json()) as {
      id: string;
      status: string;
    }[];
    expect(liveActivities.filter((activity) => activity.status === "live")).toHaveLength(2);

    const cancelledResponse = await app.request(`/v1/activities/${second.id}/cancel`, {
      method: "POST",
    });
    expect(cancelledResponse.status).toBe(200);
    const cancelled = (await cancelledResponse.json()) as { status: string };
    expect(cancelled.status).toBe("cancelled");
    const cancelledHistory = (await (
      await app.request(`/v1/activities/${second.id}/checkpoints`)
    ).json()) as { reason: string }[];
    expect(cancelledHistory.at(-1)?.reason).toBe("activity.cancelled");

    const lateCallback = await app.request(`/v1/integrations/agents/${second.id}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer callback-secret",
      },
      body: JSON.stringify({ type: "run.failed", message: "late update" }),
    });
    expect(lateCallback.status).toBe(409);

    const unauthorized = await app.request(`/v1/integrations/agents/${created.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "run.failed", message: "should not land" }),
    });
    expect(unauthorized.status).toBe(401);

    const wishlist = await app.request(`/v1/integrations/agents/${created.id}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer callback-secret",
      },
      body: JSON.stringify({
        type: "wishlist.ready",
        title: "Keyboard purchase",
        reply: "One item fits the goal.",
        wishlistEstimate: "est. S$25",
        wishlist: [
          {
            id: "keyboard",
            name: "Keyboard",
            short: "KEYS",
            spec: "wired compact keyboard",
            budget: "S$25",
            hueIndex: 5,
            category: "Electronics",
          },
        ],
        clarifications: [
          {
            itemId: "keyboard",
            prompt: "Which switch style?",
            options: [
              { name: "Quiet", range: "S$20–S$25", why: "Office friendly", imgLabel: "quiet" },
              { name: "Clicky", range: "S$20–S$25", why: "Tactile", imgLabel: "clicky" },
            ],
          },
          {
            itemId: "keyboard",
            prompt: "Duplicate question that must not repeat",
            options: [
              { name: "Wired", range: "S$20", why: "Simple", imgLabel: "wired" },
              { name: "Wireless", range: "S$25", why: "Portable", imgLabel: "wireless" },
            ],
          },
        ],
      }),
    });
    expect(wishlist.status).toBe(202);

    const preparedHistory = (await (
      await app.request(`/v1/activities/${created.id}/checkpoints`)
    ).json()) as { reason: string; activity: { wishlist: { id: string }[] } }[];
    expect(preparedHistory.map((row) => row.reason)).toEqual([
      "activity.created",
      "wishlist.prepared",
    ]);
    expect(preparedHistory.at(-1)?.activity.wishlist[0]?.id).toBe("keyboard");

    const approved = (await (
      await app.request(`/v1/activities/${created.id}/wishlist/approve`, { method: "POST" })
    ).json()) as {
      stage: string;
      wishlist: { id: string }[];
      clarifications: { itemId: string }[];
    };
    expect(approved.stage).toBe("curate");
    expect(approved.wishlist[0]?.id).toBe("keyboard");
    expect(approved.clarifications).toHaveLength(1);
    const chosen = await app.request(`/v1/activities/${created.id}/clarifications/keyboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option: "Quiet" }),
    });
    expect(chosen.status).toBe(200);

    const reopened = (await (
      await app.request(`/v1/activities/${created.id}/wishlist/reopen`, { method: "POST" })
    ).json()) as {
      stage: string;
      messages: { card?: string }[];
      clarifications: { chosen?: string }[];
    };
    expect(reopened.stage).toBe("wishlist");
    expect(reopened.messages).toHaveLength(2);
    expect(reopened.messages.at(-1)?.card).toBe("wishlist");
    expect(reopened.clarifications.every((row) => row.chosen === undefined)).toBe(true);
    const reopenedHistory = (await (
      await app.request(`/v1/activities/${created.id}/checkpoints`)
    ).json()) as { reason: string }[];
    expect(reopenedHistory.at(-1)?.reason).toBe("wishlist.reopened");

    await app.request(`/v1/activities/${created.id}/wishlist/approve`, { method: "POST" });
    await app.request(`/v1/activities/${created.id}/clarifications/keyboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option: "Quiet" }),
    });
    const dispatch = await app.request(`/v1/activities/${created.id}/dispatch`, { method: "POST" });
    expect(dispatch.status).toBe(200);
    expect(agents.searches).toBe(1);

    const update = await app.request(`/v1/integrations/agents/${created.id}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-happy-callback-token": "callback-secret",
      },
      body: JSON.stringify({
        type: "agent.update",
        agent: {
          agentId: "scout-a",
          itemId: "keyboard",
          slot: 0,
          url: "https://merchant.example/keyboard",
          stage: 1,
          action: "reading product details",
          queued: false,
          liveStreamUrl: "https://streams.example/scout-a",
        },
      }),
    });
    expect(update.status).toBe(202);
    const activity = (await update.json()) as { agents: { liveStreamUrl?: string }[] };
    expect(activity.agents).toContainEqual(
      expect.objectContaining({
        agentId: "scout-a",
        liveStreamUrl: "https://streams.example/scout-a",
      }),
    );
  });

  it("credits a verified XSGD deposit exactly once", async () => {
    const { app } = harness();
    const sessionToken = await authorizeWallet(app);
    const body = JSON.stringify({
      txHash: `0x${"ab".repeat(32)}`,
      sourceAddress: fundingAccount.address,
    });
    const response = await app.request("/v1/wallet/deposits", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-happy-wallet-session": sessionToken,
      },
      body,
    });
    expect(response.status).toBe(201);
    const result = (await response.json()) as {
      wallet: { balanceMinor: number; receipt: string };
      deposit: { status: string };
    };
    expect(result.wallet.balanceMinor).toBe(2500);
    expect(result.wallet.receipt).toContain("XSGD received");
    expect(result.deposit.status).toBe("confirmed");

    const duplicate = await app.request("/v1/wallet/deposits", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-happy-wallet-session": sessionToken,
      },
      body,
    });
    expect(duplicate.status).toBe(201);
    const duplicateResult = (await duplicate.json()) as { wallet: { balanceMinor: number } };
    expect(duplicateResult.wallet.balanceMinor).toBe(2500);
  });

  it("requires wallet ownership and keeps funding accounts isolated", async () => {
    const { app } = harness();
    const body = JSON.stringify({
      txHash: `0x${"cd".repeat(32)}`,
      sourceAddress: fundingAccount.address,
    });
    expect(
      (
        await app.request("/v1/wallet/deposits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      ).status,
    ).toBe(401);

    const sessionToken = await authorizeWallet(app);
    const wrongSource = await app.request("/v1/wallet/deposits", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-happy-wallet-session": sessionToken,
      },
      body: JSON.stringify({
        txHash: `0x${"ef".repeat(32)}`,
        sourceAddress: "0x4444444444444444444444444444444444444444",
      }),
    });
    expect(wrongSource.status).toBe(403);
  });
});
