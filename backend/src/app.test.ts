import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { EventHub } from "./events.js";
import type { AgentProvider } from "./providers/agent.js";
import type {
  IssueCardRequest,
  IssuedCard,
  PaymentProvider,
  PlacedOrder,
  PreparedCheckout,
  TopUpResult,
} from "./providers/payment.js";
import { MemoryRepository } from "./repositories/memory.js";
import { ActivityService } from "./services/activities.js";
import { PurchaseService } from "./services/purchases.js";

const config: Config = {
  PORT: 8787,
  NODE_ENV: "test",
  DATA_STORE: "memory",
  AWS_REGION: "ap-southeast-1",
  FRONTEND_ORIGIN: "http://localhost:4040",
  PUBLIC_BASE_URL: "http://localhost:8787",
  AGENT_CALLBACK_TOKEN: "callback-secret",
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

class RecordingPayments implements PaymentProvider {
  readonly mode = "remote" as const;
  async issueCard(_request: IssueCardRequest): Promise<IssuedCard> {
    return { cardId: "card-1", last4: "1234" };
  }
  async prepareCheckout(): Promise<PreparedCheckout> {
    return { checkoutId: "checkout-1", merchant: "merchant" };
  }
  async placeOrder(): Promise<PlacedOrder> {
    return { orderId: "order-1" };
  }
  async topUp(): Promise<TopUpResult> {
    return { transactionId: "0xtopup", confirmations: 3 };
  }
}

function harness() {
  const repository = new MemoryRepository();
  const events = new EventHub();
  const agents = new RecordingAgents();
  const payments = new RecordingPayments();
  const activities = new ActivityService(repository, events, agents);
  const purchases = new PurchaseService(repository, events, payments, config);
  return {
    repository,
    agents,
    app: createApp({ config, repository, events, agents, payments, activities, purchases }),
  };
}

describe("Happy backend contract", () => {
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
        clarifications: [],
      }),
    });
    expect(wishlist.status).toBe(202);

    await app.request(`/v1/activities/${created.id}/wishlist/approve`, { method: "POST" });
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

  it("uses the real top-up provider rather than fabricating a receipt", async () => {
    const { app } = harness();
    const response = await app.request("/v1/wallet/topup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountMinor: 50000 }),
    });
    expect(response.status).toBe(200);
    const wallet = (await response.json()) as { balanceMinor: number; receipt: string };
    expect(wallet.balanceMinor).toBe(532050);
    expect(wallet.receipt).toContain("0xtopup");
  });
});
