import { describe, expect, it } from "vitest";
import { claimCard, revealCard } from "../src/service/card.js";
import { createJobStore } from "../src/service/jobs.js";
import { type PurchaseJobInput, verifyGrant, verifyMerchantTotal } from "../src/service/verify.js";

const accepted = { activityId: "act_1", attemptId: "attempt_1", idempotencyKey: "k1" };

describe("job store", () => {
  it("accepts a key once and reports the repeat as not created", () => {
    const store = createJobStore();
    expect(store.accept(accepted).created).toBe(true);
    expect(store.accept(accepted).created).toBe(false);
  });

  // The one guarantee that costs real money if it is wrong.
  it("lets exactly one caller claim the card for a key", () => {
    const store = createJobStore();
    store.accept(accepted);
    expect(store.claimCardOnce("k1")).toBe(true);
    expect(store.claimCardOnce("k1")).toBe(false);
    expect(store.claimCardOnce("k1")).toBe(false);
  });

  it("cancels a named attempt, and every attempt of an activity when none is named", () => {
    const store = createJobStore();
    store.accept(accepted);
    store.accept({ activityId: "act_1", attemptId: "attempt_2", idempotencyKey: "k2" });
    expect(store.isCancelled("attempt_1")).toBe(false);
    store.cancel("act_1", "attempt_1");
    expect(store.isCancelled("attempt_1")).toBe(true);
    expect(store.isCancelled("attempt_2")).toBe(false);
    store.cancel("act_1");
    expect(store.isCancelled("attempt_2")).toBe(true);
  });
});

const job = (): PurchaseJobInput => ({
  activityId: "act_1",
  attemptId: "attempt_1",
  item: { id: "item-1", name: "Coffee" },
  listing: {
    url: "https://merchant.test/p/1",
    title: "Coffee",
    seller: "Merchant",
    price: "S$23.50",
    amountMinor: 2350,
  },
  cardGrant: {
    claimUrl: "https://happy.test/claim",
    token: "grant",
    amountMinor: 2350,
    currency: "SGD",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
  sandbox: true,
  idempotencyKey: "k1",
  amountMinor: 2350,
  callback: { url: "https://happy.test/events" },
});

describe("verification gate", () => {
  it("passes a well-formed job", () => {
    expect(verifyGrant(job())).toBeNull();
  });

  it("rejects a grant amount that disagrees with the listing", () => {
    const bad = job();
    bad.cardGrant.amountMinor = 9900;
    expect(verifyGrant(bad)).toMatch(/amount/i);
  });

  it("rejects a currency that is not SGD", () => {
    const bad = job();
    bad.cardGrant.currency = "USD";
    expect(verifyGrant(bad)).toMatch(/currency/i);
  });

  it("rejects an expired grant", () => {
    const bad = job();
    bad.cardGrant.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(verifyGrant(bad)).toMatch(/expired/i);
  });

  it("rejects a missing or non-http listing url", () => {
    const noUrl = job();
    noUrl.listing.url = undefined;
    expect(verifyGrant(noUrl)).toMatch(/url/i);
    const badScheme = job();
    badScheme.listing.url = "file:///etc/passwd";
    expect(verifyGrant(badScheme)).toMatch(/http/i);
  });

  it("rejects a merchant total even one cent over, and accepts equal or under", () => {
    expect(verifyMerchantTotal(2350, 2350)).toBeNull();
    expect(verifyMerchantTotal(2000, 2350)).toBeNull();
    expect(verifyMerchantTotal(2351, 2350)).toMatch(/exceeds/i);
  });
});

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("card claim and reveal", () => {
  it("claims by POST with the grant token", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return jsonRes({
        cardId: "c1",
        last4: "4242",
        agentAccess: { revealUrl: "https://happy.test/reveal", token: "one-use" },
      });
    }) as unknown as typeof fetch;

    const card = await claimCard(
      { claimUrl: "https://happy.test/claim", token: "grant" },
      fetchImpl,
    );
    expect(card.last4).toBe("4242");
    expect(seen[0]?.method).toBe("POST");
    expect((seen[0]?.headers as Record<string, string>).authorization).toBe("Bearer grant");
  });

  it("reveals by GET with the one-use token", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return jsonRes({ pan: "4242424242424242", expiryMonth: "12", expiryYear: "40", cvc: "123" });
    }) as unknown as typeof fetch;

    const material = await revealCard(
      { revealUrl: "https://happy.test/reveal", token: "one-use" },
      fetchImpl,
    );
    expect(material.pan).toBe("4242424242424242");
    expect(seen[0]?.method).toBe("GET");
    expect((seen[0]?.headers as Record<string, string>).authorization).toBe("Bearer one-use");
  });

  it("rejects an incomplete reveal rather than returning a partial card", async () => {
    const fetchImpl = (async () => jsonRes({ expiryMonth: "12" })) as unknown as typeof fetch;
    await expect(
      revealCard({ revealUrl: "https://happy.test/reveal", token: "t" }, fetchImpl),
    ).rejects.toThrow(/card/i);
  });

  // A claim or reveal body IS the card. An error that interpolates it leaks into logs.
  it("never puts a response body into an error message", async () => {
    const fetchImpl = (async () =>
      new Response("pan=4242424242424242", { status: 500 })) as unknown as typeof fetch;
    await expect(
      claimCard({ claimUrl: "https://happy.test/claim", token: "g" }, fetchImpl),
    ).rejects.toThrow(/^card claim refused \(500\)$/);
    await expect(
      revealCard({ revealUrl: "https://happy.test/reveal", token: "t" }, fetchImpl),
    ).rejects.toThrow(/^card reveal refused \(500\)$/);
  });
});
