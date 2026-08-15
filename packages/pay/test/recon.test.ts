import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import * as L from "../src/ledger.js";
import { resolvePending, startRecon } from "../src/recon.js";

const cfg = {
  minCardCents: 500,
  maxCardCents: 3000,
  priceToleranceBps: 200,
  chainStaleMs: 60_000,
  reservationTtlMs: 900_000,
} as any;
const chain = { balanceCents: 10000, ageMs: 0 };
let db: Db;
let mandateId: string;

const wallet = (used: boolean) =>
  ({ authorizationUsed: async () => used, view: () => chain }) as any;

beforeEach(async () => {
  db = openDb(":memory:");
  const m = await L.createMandate(db, cfg, {
    perItemCents: 2500,
    dailyCents: 15000,
    merchants: ["shop.example.com"],
    expiresAt: new Date("2026-08-20T00:00:00Z"),
  });
  mandateId = m.id;
});

async function pendingPurchase(validBefore: string) {
  const p = await L.reserveQuote(db, cfg, chain, {
    amountCents: 1800,
    merchantHost: "shop.example.com",
    itemName: "hub",
  });
  L.markPaying(db, p.id, 1800);
  db.raw
    .prepare(`INSERT INTO payments VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      `0x${"ab".repeat(32)}`,
      p.id,
      1800,
      validBefore,
      "{}",
      "PENDING",
      null,
      new Date().toISOString(),
    );
  return p;
}

describe("resolvePending", () => {
  it("leaves a payment pending while its deadline has not passed", async () => {
    await pendingPurchase(new Date(Date.now() + 60_000).toISOString());
    const r = await resolvePending({ db, cfg, wallet: wallet(false) });
    expect(r).toMatchObject({ unresolved: 1, failed: 0, settled: 0 });
  });

  it("fails a payment whose deadline passed and whose nonce was never used", async () => {
    const p = await pendingPurchase(new Date(Date.now() - 1000).toISOString());
    const r = await resolvePending({ db, cfg, wallet: wallet(false) });
    expect(r.failed).toBe(1);
    const row = db.raw.prepare(`SELECT state FROM purchases WHERE id=?`).get(p.id) as any;
    expect(row.state).toBe("FAILED");
    expect(L.totals(db, mandateId)).toMatchObject({ reservedCents: 0, spentCents: 0 });
  });

  it("strands a payment whose nonce was consumed on-chain and cannot be recovered", async () => {
    const p = await pendingPurchase(new Date(Date.now() - 1000).toISOString());
    const r = await resolvePending({ db, cfg, wallet: wallet(true) }); // no issuer: nothing to replay
    expect(r.settled).toBe(1);
    const row = db.raw.prepare(`SELECT state FROM purchases WHERE id=?`).get(p.id) as any;
    expect(row.state).toBe("STRANDED");
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 1800, strandedCents: 1800 });
  });

  it("leaves the payment PENDING and writes nothing when the replay throws (transient failure)", async () => {
    const p = await pendingPurchase(new Date(Date.now() - 1000).toISOString());
    const issuer = {
      name: "straitsx" as const,
      prepare: async () => {
        throw new Error("must not prepare a new nonce");
      },
      send: async () => {
        throw new Error("429 rate limited");
      },
      reveal: async () => {
        throw new Error("not needed");
      },
    };
    const r = await resolvePending({ db, cfg, wallet: wallet(true), issuer });
    expect(r).toMatchObject({ settled: 0, failed: 0, unresolved: 1 });
    const row = db.raw.prepare(`SELECT state FROM purchases WHERE id=?`).get(p.id) as any;
    const pay = db.raw.prepare(`SELECT state FROM payments WHERE purchase_id=?`).get(p.id) as any;
    expect(row.state).toBe("PAYING");
    expect(pay.state).toBe("PENDING");
    expect(L.totals(db, mandateId)).toMatchObject({ reservedCents: 1800, spentCents: 0 });
  });

  it("recovers the card by replaying the stored envelope when one is available", async () => {
    const p = await pendingPurchase(new Date(Date.now() - 1000).toISOString());
    const issuer = {
      name: "straitsx" as const,
      prepare: async () => {
        throw new Error("must not prepare a new nonce");
      },
      send: async () => ({
        opaqueId: "card_recovered",
        last4: "4242",
        expiresAt: null,
        settlementTx: "0xtx",
      }),
      reveal: async () => {
        throw new Error("not needed");
      },
    };
    const r = await resolvePending({ db, cfg, wallet: wallet(true), issuer });
    expect(r.settled).toBe(1);
    const row = db.raw.prepare(`SELECT state FROM purchases WHERE id=?`).get(p.id) as any;
    const card = db.raw.prepare(`SELECT opaque_id FROM cards WHERE purchase_id=?`).get(p.id) as any;
    expect(row.state).toBe("CARD_ISSUED");
    expect(card.opaque_id).toBe("card_recovered");
  });
});

describe("startRecon", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-enter resolvePending while a previous tick is still in flight", async () => {
    await pendingPurchase(new Date(Date.now() - 1000).toISOString());

    let calls = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const slowWallet = {
      authorizationUsed: async () => {
        calls++;
        await gate;
        return false;
      },
      view: () => chain,
    } as any;

    vi.useFakeTimers();
    const stop = startRecon({ db, cfg, wallet: slowWallet }, 10);
    try {
      vi.advanceTimersByTime(10); // tick 1: enters resolvePending, suspends on the gate
      vi.advanceTimersByTime(10); // tick 2: previous tick still in flight — must be skipped
      expect(calls).toBe(1);
    } finally {
      stop(); // clear the interval before releasing the gate, or the repeating timer never quiesces
      releaseGate();
      // Flush the microtask queue so the released tick's promise chain (and its
      // `running = false` reset) settles before the test ends.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  });
});
