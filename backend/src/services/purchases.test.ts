import { describe, expect, it } from "vitest";
import type { Activity } from "../domain.js";
import { DEFAULT_USER_ID } from "../domain.js";
import { EventHub } from "../events.js";
import type {
  IssueCardRequest,
  IssuedCard,
  PaymentProvider,
  PlacedOrder,
  PreparedCheckout,
  TopUpResult,
} from "../providers/payment.js";
import { MemoryRepository } from "../repositories/memory.js";
import { PurchaseService } from "./purchases.js";

class Payments implements PaymentProvider {
  readonly mode = "remote" as const;
  issued = 0;

  async issueCard(request: IssueCardRequest): Promise<IssuedCard> {
    this.issued += 1;
    expect(request.listing.amountMinor).toBe(2500);
    return { cardId: "card-1", last4: "1234" };
  }
  async prepareCheckout(): Promise<PreparedCheckout> {
    return { checkoutId: "checkout-1", merchant: "Demo Store" };
  }
  async placeOrder(): Promise<PlacedOrder> {
    return { orderId: "SG-1" };
  }
  async topUp(): Promise<TopUpResult> {
    return { transactionId: "tx", confirmations: 1 };
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

describe("PurchaseService", () => {
  it("enforces the card rail before issuing and leaves a denied activity retryable", async () => {
    const repository = new MemoryRepository();
    const payments = new Payments();
    const service = new PurchaseService(repository, new EventHub(), payments, {
      PAYMENT_MIN_MINOR: 500,
      PAYMENT_MAX_MINOR: 3000,
      PAYMENT_ATTEMPTS_PER_LISTING: 2,
    });
    const expensive = activity(3100);
    await repository.putActivity(expensive);

    await expect(service.start(expensive.id, "idempotency-expensive")).rejects.toThrow(
      "outside the issuable range",
    );
    expect(payments.issued).toBe(0);
    expect(await repository.getPurchaseClaim(expensive.id)).toBeNull();

    const pick = expensive.shortlist[0];
    if (!pick) throw new Error("test activity is missing its shortlist pick");
    pick.listing.amountMinor = 2500;
    pick.listing.price = "S$25.00";
    expensive.totalMinor = 2500;
    await repository.putActivity(expensive);
    await service.start(expensive.id, "idempotency-valid");
    const completed = await eventuallyCompleted(repository);
    expect(completed.execution[0]).toEqual({ itemId: "item-1", step: 4, state: "purchased" });
    expect(payments.issued).toBe(1);
  });

  it("returns an existing execution for the same idempotency key", async () => {
    const repository = new MemoryRepository();
    const payments = new Payments();
    const service = new PurchaseService(repository, new EventHub(), payments, {
      PAYMENT_MIN_MINOR: 500,
      PAYMENT_MAX_MINOR: 3000,
      PAYMENT_ATTEMPTS_PER_LISTING: 2,
    });
    await repository.putActivity(activity(2500));
    await service.start("activity-1", "same-idempotency-key");
    await eventuallyCompleted(repository);
    const duplicate = await service.start("activity-1", "same-idempotency-key");
    expect(duplicate.status).toBe("completed");
    expect(payments.issued).toBe(1);
  });
});
