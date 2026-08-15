import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@happy/demo-store/app";
import * as pay from "@happy/pay";
import { serve } from "@hono/node-server";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileJournal } from "../src/journal.js";
import { createCloser } from "../src/runner.js";

const PORT = 4037;
const base = `http://127.0.0.1:${PORT}`;
let server: ReturnType<typeof serve>;
let browser: Browser;

beforeAll(async () => {
  process.env.ISSUER = "mock";
  process.env.DATABASE_URL = ":memory:";
  process.env.CARD_API_BASE = "https://card.straitsx.ai/sandbox/cardapi";
  process.env.ALLOWED_NETWORK = "eip155:43113";
  process.env.CHAIN_ID = "43113";
  process.env.RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
  process.env.XSGD_ADDRESS = "0xd769410dc8772695a7f55a304d2125320a65c2a5";
  server = serve({ fetch: app.fetch, port: PORT });
  browser = await chromium.launch();
  await pay.createMandate({
    perItemCents: 3000,
    dailyCents: 15000,
    merchants: ["127.0.0.1"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
});
afterAll(async () => {
  pay.shutdown();
  await browser.close();
  server.close();
});

/** What a human does once, by hand, in a browser profile the agent will reuse. */
async function signIn(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.locator('input[autocomplete="username"]').fill("tricia.lim@hey.sg");
  await page.locator('input[autocomplete="current-password"]').fill("hunter2");
  await Promise.all([page.waitForNavigation(), page.locator('button[type="submit"]').click()]);
  await page.close();
}

const run = (context: BrowserContext, itemId: string) =>
  createCloser({
    browser: context, // a BrowserContext is a BrowserLike: it has newPage()
    onEvent: () => {},
    journal: createFileJournal(mkdtempSync(join(tmpdir(), "closer-session-"))),
  }).run({
    activityId: `act_${itemId}_${Math.round(performance.now())}`,
    idempotencyKey: "k1",
    selections: [{ itemId, url: `${base}/checkout-auth?sku=nvme-ssd` }],
  });

describe("a shop that requires an account", () => {
  it("skips the item when nobody has signed in, and spends nothing", async () => {
    const context = await browser.newContext();
    const res = await run(context, "anon");
    expect(res.items[0]).toMatchObject({ status: "skipped", reason: "PRECHECK_FAILED" });
    expect(res.totalMinor).toBe(0);
    await context.close();
  }, 120_000);

  it("buys inside a session a human signed into once", async () => {
    const context = await browser.newContext();
    await signIn(context); // the human's one-time act; the agent never sees a password
    const res = await run(context, "member");
    expect(res.items[0]).toMatchObject({ status: "purchased", amountMinor: 2900 });
    expect(res.items[0]?.orderRef).toMatch(/^ord_/);
    await context.close();
  }, 120_000);

  it("keeps the session across items, so one sign-in covers a whole basket", async () => {
    const context = await browser.newContext();
    await signIn(context);
    const first = await run(context, "one");
    const second = await run(context, "two");
    expect([first.items[0]?.status, second.items[0]?.status]).toEqual(["purchased", "purchased"]);
    await context.close();
  }, 120_000);
});
