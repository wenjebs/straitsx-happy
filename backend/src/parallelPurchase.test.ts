/**
 * Several items bought at once, each with its own card.
 *
 * This is the riskiest change in the purchase path, so the tests aim at the ways it could quietly
 * go wrong rather than at the happy path: a callback attributed to the wrong item, a card credited
 * to the wrong attempt, one item's failure taking the others down, or a run that never finishes
 * because it is waiting on an item that already gave up.
 */
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import type { Activity } from "./domain.js";
import { EventHub } from "./events.js";
import type { CardProvider, IssueCardRequest, IssuedCard, TopUpResult } from "./providers/card.js";
import type {
  PurchaseAgentCancelRequest,
  PurchaseAgentProvider,
  PurchaseAgentRequest,
} from "./providers/purchaseAgent.js";
import { MemoryRepository } from "./repositories/memory.js";
import { PurchaseService } from "./services/purchases.js";

const config = {
  PUBLIC_BASE_URL: "http://localhost:8787",
  PAYMENT_MIN_MINOR: 500,
  PAYMENT_MAX_MINOR: 3000,
  PAYMENT_ATTEMPTS_PER_LISTING: 2,
} as unknown as Config;

class Cards implements CardProvider {
  readonly mode = "remote" as const;
  readonly issued: string[] = [];
  async issueCard(request: IssueCardRequest): Promise<IssuedCard> {
    // Keyed by the caller's idempotency key so two concurrent attempts cannot share a card.
    this.issued.push(request.idempotencyKey);
    const n = this.issued.length;
    return {
      cardId: `card-${request.idempotencyKey}`,
      last4: String(1000 + n),
      agentAccess: { revealUrl: `https://cards.test/${n}`, token: "t" },
    };
  }
  async topUp(): Promise<TopUpResult> {
    return { transactionId: "0x", confirmations: 1 };
  }
}

class Agents implements PurchaseAgentProvider {
  readonly mode = "remote" as const;
  readonly started: PurchaseAgentRequest[] = [];
  readonly cancelled: PurchaseAgentCancelRequest[] = [];
  /** Item ids that should fail to dispatch, to prove one bad item does not sink the rest. */
  failFor = new Set<string>();
  /** Item ids whose dispatch hangs, to open the window a callback can arrive in. */
  hangFor = new Set<string>();
  private release: (() => void)[] = [];
  releaseHung() {
    for (const r of this.release) r();
    this.release = [];
  }
  async startPurchase(request: PurchaseAgentRequest): Promise<void> {
    if (this.failFor.has(request.item.id)) throw new Error("merchant refused the job");
    this.started.push(request);
    if (this.hangFor.has(request.item.id)) {
      await new Promise<void>((resolve) => this.release.push(resolve));
    }
  }
  async cancelPurchase(request: PurchaseAgentCancelRequest): Promise<void> {
    this.cancelled.push(request);
  }
}

const ITEMS = ["cleanser", "capo", "chew-toy"];

async function harness(itemIds: string[] = ITEMS) {
  const repository = new MemoryRepository();
  const events = new EventHub();
  const cards = new Cards();
  const agents = new Agents();
  const purchases = new PurchaseService(repository, events, cards, agents, config);

  const activity: Activity = {
    id: "act_par",
    userId: "demo-user",
    title: "Parallel run",
    stage: "shortlist",
    status: "live",
    createdAt: new Date().toISOString(),
    displayTs: "now",
    messages: [],
    wishlist: itemIds.map((id, i) => ({
      id,
      name: id,
      short: id.slice(0, 4).toUpperCase(),
      hueIndex: i,
      spec: "",
      category: "General",
    })),
    wishlistEstimate: "",
    clarifications: [],
    itemProgress: [],
    agents: [],
    searchPlaying: false,
    shortlist: itemIds.map((id) => ({
      itemId: id,
      reSearched: false,
      listing: {
        title: `${id} listing`,
        seller: "Shop",
        rating: "5",
        price: "S$10.00",
        amountMinor: 1000,
        why: "match",
        url: `https://shop.test/${id}`,
      },
      alternates: [],
    })),
    execution: [],
    log: [],
    totalMinor: 0,
  } as unknown as Activity;

  await repository.putActivity(activity, "test.seed");
  const wallet = await repository.getWallet("demo-user");
  wallet.balanceMinor = 100_000;
  await repository.putWallet("demo-user", wallet);
  const settings = await repository.getSettings("demo-user");
  await repository.putSettings("demo-user", {
    ...settings,
    shippingAddress: {
      recipientName: "Demo User",
      addressLine1: "1 Test Street",
      addressLine2: "#01-01",
      city: "Singapore",
      stateOrProvince: "Singapore",
      postalCode: "018956",
      country: "Singapore",
      phone: "+65 6123 4567",
    },
  });

  return { repository, purchases, cards, agents, activity };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("buying several items at once", () => {
  it("dispatches every item concurrently rather than one at a time", async () => {
    const { purchases, agents } = await harness();
    await purchases.start("act_par", "key-1");
    await settle();

    expect(agents.started).toHaveLength(3);
    expect(new Set(agents.started.map((r) => r.item.id))).toEqual(new Set(ITEMS));
    // Distinct attempts: sharing one would make every callback ambiguous.
    expect(new Set(agents.started.map((r) => r.attemptId)).size).toBe(3);
    // Distinct idempotency keys: sharing one would make the card provider return the same card.
    expect(new Set(agents.started.map((r) => r.idempotencyKey)).size).toBe(3);
  });

  it("gives each attempt its own card", async () => {
    const { purchases, agents, cards } = await harness();
    await purchases.start("act_par", "key-1");
    await settle();

    for (const started of agents.started) {
      await purchases.claimCard("act_par", started.attemptId, started.cardGrant.token);
    }
    expect(new Set(cards.issued).size).toBe(3);
  });

  it("refuses a card grant presented against another attempt's id", async () => {
    const { purchases, agents } = await harness();
    await purchases.start("act_par", "key-1");
    await settle();

    const [a, b] = agents.started;
    if (!a || !b) throw new Error("expected two attempts");
    // b's token against a's attempt: the exact confusion concurrency invites.
    await expect(purchases.claimCard("act_par", a.attemptId, b.cardGrant.token)).rejects.toThrow(
      /invalid|stale/i,
    );
  });

  it("routes a callback to the item its attempt belongs to", async () => {
    const { purchases, agents } = await harness();
    await purchases.start("act_par", "key-1");
    await settle();

    const capo = agents.started.find((r) => r.item.id === "capo");
    if (!capo) throw new Error("capo attempt missing");

    const activity = await purchases.handleAgentEvent("act_par", {
      eventId: "e1",
      attemptId: capo.attemptId,
      itemId: "capo",
      type: "checkout.prepared",
      message: "ready",
    });

    const rows = Object.fromEntries(activity.execution.map((r) => [r.itemId, r.action]));
    expect(rows.capo).toBe("ready");
    // The others must be untouched — attributing one item's progress to another is the failure
    // mode a shared cursor produced.
    expect(rows.cleanser).not.toBe("ready");
  });

  it("rejects a callback whose attemptId does not match its itemId", async () => {
    const { purchases, agents } = await harness();
    await purchases.start("act_par", "key-1");
    await settle();
    const capo = agents.started.find((r) => r.item.id === "capo");
    if (!capo) throw new Error("capo attempt missing");

    await expect(
      purchases.handleAgentEvent("act_par", {
        eventId: "e2",
        attemptId: capo.attemptId,
        itemId: "cleanser",
        type: "checkout.prepared",
      }),
    ).rejects.toThrow(/stale or unknown/i);
  });

  it("keeps the other items going when one fails to dispatch", async () => {
    const { purchases, agents } = await harness();
    agents.failFor.add("capo");
    await purchases.start("act_par", "key-1");
    await settle();

    expect(new Set(agents.started.map((r) => r.item.id))).toEqual(
      new Set(["cleanser", "chew-toy"]),
    );
  });

  /*
   * The defect an adversarial review found and reproduced, at a cost of real money: startAttempts
   * held one run snapshot across the dispatch await and wrote it again afterwards, erasing the card
   * fields a concurrent claimCard had persisted. The card had been minted and the merchant charged,
   * but confirmOrder then refused the order for having no card — a successful purchase reported as
   * a failure, with a stranded card nothing would ever mark dead.
   */
  it("keeps a card claimed while a sibling was still dispatching", async () => {
    const { purchases, agents, repository } = await harness();
    agents.hangFor.add("chew-toy");
    void purchases.start("act_par", "key-1");
    await settle();

    const cleanser = agents.started.find((r) => r.item.id === "cleanser");
    if (!cleanser) throw new Error("cleanser attempt missing");

    // Claim while the sibling's dispatch is still outstanding — the exact window.
    await purchases.claimCard("act_par", cleanser.attemptId, cleanser.cardGrant.token);
    agents.releaseHung();
    await settle();
    await settle();

    const run = await repository.getPurchaseRun("act_par");
    const attempt = run?.attempts[cleanser.attemptId];
    expect(attempt?.cardLast4, "card claim was erased by a stale write").toBeTruthy();
    expect(attempt?.cardClaimedAt).toBeTruthy();
  });

  /*
   * Six attempts claiming at once each held their own wallet copy across a 45-second issueCard.
   * Whoever wrote last erased the others' card rows, so the ledger under-reported money that had
   * genuinely left — and the inflated balance then passed the funds check for the next card.
   */
  it("keeps every card row when several attempts claim at once", async () => {
    const { purchases, agents, repository } = await harness();
    await purchases.start("act_par", "key-1");
    await settle();

    await Promise.all(
      agents.started.map((s) => purchases.claimCard("act_par", s.attemptId, s.cardGrant.token)),
    );

    const wallet = await repository.getWallet("demo-user");
    expect(wallet.cards.filter((c) => c.status === "issued")).toHaveLength(3);
  });

  it("records every debit when several orders confirm at once", async () => {
    const { purchases, agents, repository } = await harness();
    await purchases.start("act_par", "key-1");
    await settle();
    const before = (await repository.getWallet("demo-user")).balanceMinor;

    for (const s of agents.started) {
      await purchases.claimCard("act_par", s.attemptId, s.cardGrant.token);
    }
    await Promise.all(
      agents.started.map((s, i) =>
        purchases.handleAgentEvent("act_par", {
          eventId: `c-${i}`,
          attemptId: s.attemptId,
          itemId: s.item.id,
          type: "order.confirmed",
          orderId: `ORD-${i}`,
        }),
      ),
    );

    const wallet = await repository.getWallet("demo-user");
    // Three items at S$10.00 each. A lost debit shows up here and nowhere else.
    expect(before - wallet.balanceMinor).toBe(3000);
    expect(wallet.transactions.filter((t) => t.debit)).toHaveLength(3);
  });

  it("completes only once every item has finished", async () => {
    const { purchases, agents, repository } = await harness();
    await purchases.start("act_par", "key-1");
    await settle();

    let i = 0;
    for (const started of agents.started) {
      await purchases.claimCard("act_par", started.attemptId, started.cardGrant.token);
      await purchases.handleAgentEvent("act_par", {
        eventId: `ok-${i++}`,
        attemptId: started.attemptId,
        itemId: started.item.id,
        type: "order.confirmed",
        orderId: `ORD-${i}`,
      });
      await settle();
    }

    const run = await repository.getPurchaseRun("act_par");
    expect(run?.status).toBe("completed");
    const activity = await repository.getActivity("act_par");
    expect(activity?.status).toBe("completed");
  });
});
