import { describe, expect, it } from "vitest";
import type { Activity } from "../domain.js";
import { DEFAULT_USER_ID } from "../domain.js";
import { EventHub } from "../events.js";
import type { CardProvider, IssueCardRequest, IssuedCard, TopUpResult } from "../providers/card.js";
import type { PurchaseAgentProvider, PurchaseAgentRequest } from "../providers/purchaseAgent.js";
import { MemoryRepository } from "../repositories/memory.js";
import { PurchaseService } from "./purchases.js";

class Cards implements CardProvider {
  readonly mode = "remote" as const;
  issued = 0;

  async issueCard(request: IssueCardRequest): Promise<IssuedCard> {
    this.issued += 1;
    expect(request.listing.amountMinor).toBe(2500);
    return {
      cardId: "card-1",
      last4: "1234",
      agentAccess: { revealUrl: "https://cards.example/card-1", token: "secret" },
    };
  }
  async topUp(): Promise<TopUpResult> {
    return { transactionId: "tx", confirmations: 1 };
  }
}

class PurchaseAgents implements PurchaseAgentProvider {
  readonly mode = "remote" as const;
  requests: PurchaseAgentRequest[] = [];
  async startPurchase(request: PurchaseAgentRequest): Promise<void> {
    this.requests.push(request);
  }
}

function activity(amountMinor: number): Activity {
  return {
    id: "activity-1",
    userId: DEFAULT_USER_ID,
    title: "Small purchase",
    stage: "shortlist",
    status: "live",
    createdAt: new Date().toISOString(),
    displayTs: "now",
    messages: [],
    wishlist: [
      {
        id: "item-1",
        name: "Adapter",
        short: "ADPT",
        spec: "USB-C",
        budget: "S$25",
        hueIndex: 0,
        category: "Electronics",
      },
    ],
    wishlistEstimate: "est. S$25",
    clarifications: [],
    itemProgress: [],
    agents: [],
    searchPlaying: false,
    shortlist: [
      {
        itemId: "item-1",
        reSearched: false,
        listing: {
          title: "USB-C adapter",
          seller: "Demo Store",
          rating: "4.9",
          price: `S$${(amountMinor / 100).toFixed(2)}`,
          amountMinor,
          why: "Within spec",
          url: "https://store.example/adapter",
        },
      },
    ],
    execution: [],
    log: [],
    totalMinor: amountMinor,
  };
}

async function eventuallyCompleted(repository: MemoryRepository): Promise<Activity> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await repository.getActivity("activity-1");
    if (current?.status === "completed") return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("purchase did not complete");
}

async function finishPurchase(service: PurchaseService, agents: PurchaseAgents): Promise<void> {
  const request = await waitForJob(agents);
  await service.claimCard(request.activityId, request.attemptId, request.cardGrant.token);
  await service.handleAgentEvent(request.activityId, {
    type: "browser.started",
    eventId: "event-browser",
    attemptId: request.attemptId,
    itemId: request.item.id,
    liveStreamUrl: "https://streams.example/closer",
  });
  await service.handleAgentEvent(request.activityId, {
    type: "order.confirmed",
    eventId: "event-confirmed",
    attemptId: request.attemptId,
    itemId: request.item.id,
    orderId: "SG-1",
  });
}

async function waitForJob(agents: PurchaseAgents): Promise<PurchaseAgentRequest> {
  for (let attempt = 0; attempt < 50 && agents.requests.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const request = agents.requests[0];
  if (!request) throw new Error("purchase agent did not receive a job");
  return request;
}

describe("PurchaseService", () => {
  it("enforces the card rail before issuing and leaves a denied activity retryable", async () => {
    const repository = new MemoryRepository();
    const cards = new Cards();
    const agents = new PurchaseAgents();
    const service = new PurchaseService(repository, new EventHub(), cards, agents, {
      PUBLIC_BASE_URL: "http://localhost:8787",
      PAYMENT_MIN_MINOR: 500,
      PAYMENT_MAX_MINOR: 3000,
      PAYMENT_ATTEMPTS_PER_LISTING: 2,
    });
    const expensive = activity(3100);
    await repository.putActivity(expensive);

    await expect(service.start(expensive.id, "idempotency-expensive")).rejects.toThrow(
      "outside the issuable range",
    );
    expect(cards.issued).toBe(0);
    expect(await repository.getPurchaseClaim(expensive.id)).toBeNull();

    const pick = expensive.shortlist[0];
    if (!pick) throw new Error("test activity is missing its shortlist pick");
    pick.listing.amountMinor = 2500;
    pick.listing.price = "S$25.00";
    expensive.totalMinor = 2500;
    await repository.putActivity(expensive);
    await service.start(expensive.id, "idempotency-valid");
    const job = await waitForJob(agents);
    expect(cards.issued).toBe(0);
    await expect(service.claimCard(job.activityId, job.attemptId, "wrong-grant")).rejects.toThrow(
      "missing or invalid",
    );
    expect(cards.issued).toBe(0);
    await finishPurchase(service, agents);
    const completed = await eventuallyCompleted(repository);
    expect(completed.execution[0]).toEqual(
      expect.objectContaining({ itemId: "item-1", step: 4, state: "purchased" }),
    );
    expect(cards.issued).toBe(1);
  });

  it("returns an existing execution for the same idempotency key", async () => {
    const repository = new MemoryRepository();
    const cards = new Cards();
    const agents = new PurchaseAgents();
    const service = new PurchaseService(repository, new EventHub(), cards, agents, {
      PUBLIC_BASE_URL: "http://localhost:8787",
      PAYMENT_MIN_MINOR: 500,
      PAYMENT_MAX_MINOR: 3000,
      PAYMENT_ATTEMPTS_PER_LISTING: 2,
    });
    await repository.putActivity(activity(2500));
    await service.start("activity-1", "same-idempotency-key");
    await finishPurchase(service, agents);
    await eventuallyCompleted(repository);
    const duplicate = await service.start("activity-1", "same-idempotency-key");
    expect(duplicate.status).toBe("completed");
    expect(cards.issued).toBe(1);
  });
});
