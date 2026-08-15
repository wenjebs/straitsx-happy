import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { MockIssuer } from "../src/issuer/mock.js";
import * as L from "../src/ledger.js";
import { issueCardFor } from "../src/purchase.js";

const cfg = {
  minCardCents: 500,
  maxCardCents: 3000,
  priceToleranceBps: 200,
  chainStaleMs: 60_000,
  reservationTtlMs: 900_000,
  cardholderName: "Happy Agent",
  cardHeadroomCents: 0,
} as any;

const wallet = { view: () => ({ balanceCents: 10000, ageMs: 0 }) } as any;
let db: Db;

beforeEach(async () => {
  db = openDb(":memory:");
  await L.createMandate(db, cfg, {
    perItemCents: 2500,
    dailyCents: 15000,
    merchants: ["shop.example.com"],
    expiresAt: new Date("2026-08-20T00:00:00Z"),
  });
});

const reserve = () =>
  L.reserveQuote(db, cfg, wallet.view(), {
    amountCents: 1800,
    merchantHost: "shop.example.com",
    itemName: "hub",
  });

describe("issueCardFor", () => {
  it("issues once and moves money from reserved to spent", async () => {
    const p = await reserve();
    const deps = { db, cfg, issuer: new MockIssuer(), wallet };
    const r = await issueCardFor(deps, p.id, 1800);
    expect(r.last4).toHaveLength(4);
    expect(L.totals(db)).toMatchObject({ spentCents: 1800, reservedCents: 0 });
  });

  it("returns the same card on a second call and issues nothing new", async () => {
    const p = await reserve();
    const issuer = new MockIssuer();
    const spy = vi.spyOn(issuer, "send");
    const deps = { db, cfg, issuer, wallet };
    const a = await issueCardFor(deps, p.id, 1800);
    const b = await issueCardFor(deps, p.id, 1800);
    expect(b.opaqueId).toBe(a.opaqueId);
    expect(spy).toHaveBeenCalledTimes(1);
    const n = db.raw
      .prepare(`SELECT count(*) c FROM payments WHERE purchase_id=?`)
      .get(p.id) as any;
    expect(n.c).toBe(1);
  });

  it("refuses a final total above the price tolerance", async () => {
    const p = await reserve();
    const deps = { db, cfg, issuer: new MockIssuer(), wallet };
    await expect(issueCardFor(deps, p.id, 1900)).rejects.toMatchObject({ reason: "PRICE_CHANGED" });
    const row = db.raw.prepare(`SELECT state FROM purchases WHERE id=?`).get(p.id) as any;
    expect(row.state).toBe("RESERVED"); // untouched, still usable
  });

  it("accepts a final total inside the tolerance and charges the final amount", async () => {
    const p = await reserve();
    const deps = { db, cfg, issuer: new MockIssuer(), wallet };
    await issueCardFor(deps, p.id, 1830);
    expect(L.totals(db)).toMatchObject({ spentCents: 1830 });
  });

  it("refuses to issue for a NEEDS_HUMAN purchase until approved", async () => {
    const p = await L.reserveQuote(db, cfg, wallet.view(), {
      amountCents: 2600,
      merchantHost: "shop.example.com",
      itemName: "monitor",
    });
    const deps = { db, cfg, issuer: new MockIssuer(), wallet };
    await expect(issueCardFor(deps, p.id, 2600)).rejects.toThrow(/approval/);
    L.approvePurchase(db, p.id);
    await expect(issueCardFor(deps, p.id, 2600)).resolves.toBeTruthy();
  });

  it("leaves the purchase PAYING and the payment PENDING when the issuer throws mid-flight", async () => {
    const p = await reserve();
    const issuer = new MockIssuer();
    vi.spyOn(issuer, "send").mockRejectedValueOnce(
      Object.assign(new Error("socket hang up"), { code: "UNAVAILABLE" }),
    );
    const deps = { db, cfg, issuer, wallet };
    await expect(issueCardFor(deps, p.id, 1800)).rejects.toThrow(/socket hang up/);
    const row = db.raw.prepare(`SELECT state FROM purchases WHERE id=?`).get(p.id) as any;
    const pay = db.raw
      .prepare(`SELECT state, nonce, envelope FROM payments WHERE purchase_id=?`)
      .get(p.id) as any;
    expect(row.state).toBe("PAYING");
    expect(pay.state).toBe("PENDING");
    // the row must carry what reconciliation needs: a real on-chain nonce and replayable bytes
    expect(pay.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pay.envelope).toBeTruthy();
  });
});
