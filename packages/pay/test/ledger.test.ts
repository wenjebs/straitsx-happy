import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import * as L from "../src/ledger.js";

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

beforeEach(async () => {
  db = openDb(":memory:");
  chain.balanceCents = 10000;
  const m = await L.createMandate(db, cfg, {
    perItemCents: 2500,
    dailyCents: 15000,
    merchants: ["shop.example.com"],
    expiresAt: new Date("2026-08-20T00:00:00Z"),
  });
  mandateId = m.id;
});

const q = { amountCents: 1800, merchantHost: "shop.example.com", itemName: "hub" };

describe("ledger", () => {
  it("reserves and reports totals", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    expect(p.state).toBe("RESERVED");
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 0, reservedCents: 1800 });
  });

  it("moves reserved to spent when the card is issued, not when completed", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    L.markPaying(db, p.id, 1800);
    L.markIssued(db, p.id, 1800, {
      issuer: "mock",
      opaqueId: "o1",
      last4: "4242",
      expiresAt: null,
    });
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 1800, reservedCents: 0 });
    L.markDone(db, p.id, "order-1");
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 1800, reservedCents: 0 });
  });

  it("keeps stranded money in spent", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    L.markPaying(db, p.id, 1800);
    L.markIssued(db, p.id, 1800, {
      issuer: "mock",
      opaqueId: "o1",
      last4: "4242",
      expiresAt: null,
    });
    L.markCancelled(db, p.id, "out_of_stock");
    const row = db.raw.prepare(`SELECT state FROM purchases WHERE id=?`).get(p.id) as any;
    expect(row.state).toBe("STRANDED");
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 1800, strandedCents: 1800 });
  });

  it("returns budget when a reserved purchase is cancelled", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    L.markCancelled(db, p.id, "changed_mind");
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 0, reservedCents: 0 });
  });

  it("refuses to cancel a purchase that is PAYING", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    L.markPaying(db, p.id, 1800);
    expect(() => L.markCancelled(db, p.id, "nope")).toThrow(/PAYING/);
  });

  it("refuses to cancel a purchase that is already DONE, leaving spent unchanged", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    L.markPaying(db, p.id, 1800);
    L.markIssued(db, p.id, 1800, {
      issuer: "mock",
      opaqueId: "o1",
      last4: "4242",
      expiresAt: null,
    });
    L.markDone(db, p.id, "order-1");
    expect(() => L.markCancelled(db, p.id, "retry_after_ok")).toThrow(/DONE/);
    const row = db.raw.prepare(`SELECT state FROM purchases WHERE id=?`).get(p.id) as any;
    expect(row.state).toBe("DONE");
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 1800 });
  });

  it("refuses to cancel a purchase that is already STRANDED (double cancel)", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    L.markPaying(db, p.id, 1800);
    L.markIssued(db, p.id, 1800, {
      issuer: "mock",
      opaqueId: "o1",
      last4: "4242",
      expiresAt: null,
    });
    L.markCancelled(db, p.id, "out_of_stock");
    expect(() => L.markCancelled(db, p.id, "out_of_stock_again")).toThrow(/STRANDED/);
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 1800, strandedCents: 1800 });
  });

  it("does not release an expired reservation that is PAYING", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    L.markPaying(db, p.id, 1800);
    db.raw.prepare(`UPDATE purchases SET reserved_until='2000-01-01' WHERE id=?`).run(p.id);
    expect(L.releaseExpired(db)).toBe(0);
  });

  it("rejects a second reservation that would exceed the balance", async () => {
    chain.balanceCents = 3000;
    await L.reserveQuote(db, cfg, chain, { ...q, amountCents: 2500 });
    await expect(L.reserveQuote(db, cfg, chain, { ...q, amountCents: 2000 })).rejects.toMatchObject(
      { reason: "NOT_ENOUGH_MONEY" },
    );
  });

  it("records an audit event for every transition", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    L.markPaying(db, p.id, 1800);
    const kinds = db.raw
      .prepare(`SELECT kind FROM audit_events WHERE purchase_id=?`)
      .all(p.id)
      .map((r: any) => r.kind);
    expect(kinds).toEqual(["RESERVED", "PAYING"]);
  });

  it("still counts a PAYING purchase as reserved, not spent", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    L.markPaying(db, p.id, 1800);
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 0, reservedCents: 1800 });
  });

  it("spends the final amount, not the quoted amount, once the card is issued", async () => {
    const p = await L.reserveQuote(db, cfg, chain, q);
    L.markPaying(db, p.id, 1750); // final differs from the 1800 quote
    L.markIssued(db, p.id, 1750, {
      issuer: "mock",
      opaqueId: "o1",
      last4: "4242",
      expiresAt: null,
    });
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 1750, reservedCents: 0 });
  });

  it("scopes totals to the active mandate only, ignoring purchases under other mandates", async () => {
    await L.reserveQuote(db, cfg, chain, q); // reserved under the first (still active) mandate
    const other = await L.createMandate(db, cfg, {
      perItemCents: 2500,
      dailyCents: 15000,
      merchants: ["shop.example.com"],
      expiresAt: new Date("2026-08-21T00:00:00Z"),
    });
    await L.reserveQuote(db, cfg, chain, { ...q, amountCents: 900 });
    expect(L.totals(db, other.id)).toMatchObject({ reservedCents: 900 });
    expect(L.totals(db, mandateId)).toMatchObject({ reservedCents: 1800 });
  });

  it("returns zeros when there is no active mandate", () => {
    expect(L.totals(db, null)).toEqual({ spentCents: 0, reservedCents: 0, strandedCents: 0 });
  });
});
