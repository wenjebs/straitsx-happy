import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import * as L from "../src/ledger.js";
import { resolvePending } from "../src/recon.js";

const cfg = {
  minCardCents: 500,
  maxCardCents: 3000,
  priceToleranceBps: 200,
  chainStaleMs: 60_000,
  reservationTtlMs: 900_000,
} as any;
const chain = { balanceCents: 10000, ageMs: 0 };
let db: Db;

const wallet = (used: boolean) =>
  ({ authorizationUsed: async () => used, view: () => chain }) as any;

beforeEach(async () => {
  db = openDb(":memory:");
  await L.createMandate(db, cfg, {
    perItemCents: 2500,
    dailyCents: 15000,
    merchants: ["shop.example.com"],
    expiresAt: new Date("2026-08-20T00:00:00Z"),
  });
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
    expect(L.totals(db)).toMatchObject({ reservedCents: 0, spentCents: 0 });
  });

  it("strands a payment whose nonce was consumed on-chain and cannot be recovered", async () => {
    const p = await pendingPurchase(new Date(Date.now() - 1000).toISOString());
    const r = await resolvePending({ db, cfg, wallet: wallet(true) }); // no issuer: nothing to replay
    expect(r.settled).toBe(1);
    const row = db.raw.prepare(`SELECT state FROM purchases WHERE id=?`).get(p.id) as any;
    expect(row.state).toBe("STRANDED");
    expect(L.totals(db)).toMatchObject({ spentCents: 1800, strandedCents: 1800 });
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
