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
let mandateId: string;

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
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 1800, reservedCents: 0 });
    // A PENDING row left behind on an issued purchase gets picked up by reconciliation:
    // if the chain reports the nonce unused, it marks the purchase FAILED and releases
    // budget for a card that already exists. The step-4 transaction must have settled it.
    const pay = db.raw
      .prepare(`SELECT state, tx_hash, amount_cents FROM payments WHERE purchase_id=?`)
      .get(p.id) as any;
    expect(pay.state).toBe("SETTLED");
    expect(pay.tx_hash).toBe(r.settlementTx);
    expect(pay.amount_cents).toBe(1800); // the amount actually authorised, not a stale quote
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
    expect(L.totals(db, mandateId)).toMatchObject({ spentCents: 1830 });
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

  it("refuses a final total that crosses into NEEDS_HUMAN even though the quote was auto-approved", async () => {
    // Quote 2480 is under the 2500 per-item cap, so reserveQuote auto-approves it (ALLOW).
    // Final total 2525 is inside the 200bps tolerance ceiling of 2529 (no PRICE_CHANGED) but
    // over the per-item cap, so re-decision returns NEEDS_HUMAN. The frozen `approved` flag
    // must not be treated as approval of this higher final amount.
    const p = await L.reserveQuote(db, cfg, wallet.view(), {
      amountCents: 2480,
      merchantHost: "shop.example.com",
      itemName: "monitor",
    });
    const deps = { db, cfg, issuer: new MockIssuer(), wallet };
    await expect(issueCardFor(deps, p.id, 2525)).rejects.toThrow(/approval/);
    const card = db.raw.prepare(`SELECT * FROM cards WHERE purchase_id=?`).get(p.id);
    expect(card).toBeUndefined();
  });

  it("does not deny a purchase by its own held reservation against a tight daily cap", async () => {
    // A loose daily cap (the fixture default of 15000) never exercises the ownReservationCents
    // exclusion in decide() — a purchase's own RESERVED hold would need to double-count with
    // itself to breach it. Tighten the cap to 2000 against a 1800 reservation so the exclusion
    // has to work for issuance to succeed at all.
    await L.createMandate(db, cfg, {
      perItemCents: 2500,
      dailyCents: 2000,
      merchants: ["shop.example.com"],
      expiresAt: new Date("2026-08-20T00:00:00Z"),
    });
    const p = await reserve();
    const deps = { db, cfg, issuer: new MockIssuer(), wallet };
    await expect(issueCardFor(deps, p.id, 1800)).resolves.toBeTruthy();
  });
});
