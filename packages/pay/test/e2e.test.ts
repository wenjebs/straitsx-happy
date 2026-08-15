import { app } from "@happy/demo-store/app";
import { serve } from "@hono/node-server";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as pay from "../src/index.js";

let server: any, browser: Browser;

beforeAll(async () => {
  process.env.ISSUER = "mock";
  process.env.DATABASE_URL = ":memory:";
  process.env.CARD_API_BASE = "https://card.straitsx.ai/sandbox/cardapi";
  process.env.ALLOWED_NETWORK = "eip155:43113";
  process.env.CHAIN_ID = "43113";
  process.env.RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
  process.env.XSGD_ADDRESS = "0xd769410dc8772695a7f55a304d2125320a65c2a5";
  server = serve({ fetch: app.fetch, port: 4032 });
  browser = await chromium.launch();
});
afterAll(async () => {
  pay.shutdown(); // stops the 5s balance timer and the 10s reconciler
  await browser.close();
  server.close();
});

describe("end to end, offline", () => {
  it("completes a purchase and shows it in the activity feed", async () => {
    await pay.createMandate({
      perItemCents: 2500,
      dailyCents: 15000,
      merchants: ["127.0.0.1"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const q = { amountCents: 1800, merchantHost: "127.0.0.1", itemName: "Anker USB-C Hub" };
    expect((await pay.evaluate(q)).decision).toBe("ALLOW");

    const p = await pay.reserve(q);
    const card = await pay.issueCard(p.id, 1800);
    expect(card.last4).toHaveLength(4);

    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:4032/checkout?sku=usb-c-hub");
    const r = await pay.payWithCard(page, p.id);
    expect(r.ok).toBe(true);
    await pay.complete(p.id, r.orderRef ?? null);
    await page.close();

    const feed = await pay.listPurchases(10);
    expect(feed[0]).toMatchObject({ state: "DONE", itemName: "Anker USB-C Hub" });

    const m = await pay.getMandate();
    expect(m!.spentCents).toBe(1800);
    expect(m!.footer).toContain("auto-approve under S$25/item"); // whole dollars drop the .00
  }, 90_000);

  it("refuses a hostile product page and records the refusal", async () => {
    // The injected page tells the agent to buy elsewhere at a higher amount.
    const hostile = {
      amountCents: 5000,
      merchantHost: "attacker.example.com",
      itemName: "Gift cards",
    };
    const d = await pay.evaluate(hostile);
    expect(d).toEqual({ decision: "DENY", reason: "ABOVE_RAIL_MAXIMUM" });

    const wrongMerchant = {
      amountCents: 1800,
      merchantHost: "attacker.example.com",
      itemName: "Gift cards",
    };
    expect(await pay.evaluate(wrongMerchant)).toEqual({
      decision: "DENY",
      reason: "MERCHANT_NOT_ALLOWED",
    });
    await expect(pay.reserve(wrongMerchant)).rejects.toMatchObject({
      reason: "MERCHANT_NOT_ALLOWED",
    });
  });

  it("never leaks card material through the public API", async () => {
    const feed = await pay.listPurchases(10);
    const json = JSON.stringify(feed);
    expect(json).not.toMatch(/\b\d{16}\b/);
    expect(json.toLowerCase()).not.toContain("cvc");
  });
});
