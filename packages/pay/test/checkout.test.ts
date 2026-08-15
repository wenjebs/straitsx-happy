import { app } from "@happy/demo-store/app";
import { serve } from "@hono/node-server";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { payWithCard } from "../src/checkout.js";
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

let server: any, browser: Browser, db: Db, issuer: MockIssuer, purchaseId: string;

beforeAll(async () => {
  server = serve({ fetch: app.fetch, port: 4031 });
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  server.close();
});

// Every case gets its own database and its own issued card — no order dependence.
beforeEach(async () => {
  db = openDb(":memory:");
  issuer = new MockIssuer();
  await L.createMandate(db, cfg, {
    perItemCents: 2500,
    dailyCents: 15000,
    merchants: ["127.0.0.1"],
    expiresAt: new Date("2026-08-20T00:00:00Z"),
  });
  const p = await L.reserveQuote(db, cfg, wallet.view(), {
    amountCents: 1800,
    merchantHost: "127.0.0.1",
    itemName: "hub",
  });
  purchaseId = p.id;
  await issueCardFor({ db, cfg, issuer, wallet }, purchaseId, 1800);
});

describe("payWithCard", () => {
  it("fills the form, submits, and extracts the order reference", async () => {
    const p = { id: purchaseId };
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:4031/checkout?sku=usb-c-hub");
    const r = await payWithCard({ db, issuer }, page, p.id);

    expect(r.ok).toBe(true);
    expect(r.orderRef).toMatch(/^ord_/);
    await page.close();
  }, 60_000);

  it("reports FIELDS_NOT_FOUND on a page with no card form", async () => {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:4031/item/usb-c-hub"); // a product page, no form
    const r = await payWithCard({ db, issuer }, page, purchaseId);
    expect(r).toEqual({ ok: false, error: "FIELDS_NOT_FOUND" });
    await page.close();
  }, 60_000);

  it("reports CARD_UNREADABLE when the issuer cannot produce the number", async () => {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:4031/checkout?sku=usb-c-hub");
    db.raw.prepare(`UPDATE cards SET opaque_id='unknown' WHERE purchase_id=?`).run(purchaseId);
    const r = await payWithCard({ db, issuer }, page, purchaseId);
    expect(r).toEqual({ ok: false, error: "CARD_UNREADABLE" });
    await page.close();
  }, 60_000);
});
