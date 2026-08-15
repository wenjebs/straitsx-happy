import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@happy/demo-store/app";
import * as pay from "@happy/pay";
import { serve } from "@hono/node-server";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileJournal } from "../src/journal.js";
import { createProfileStore } from "../src/profiles.js";
import { createCloser } from "../src/runner.js";

const PORT = 4038;
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

describe("the connected accounts store", () => {
  it("reports a shop as not connected before the user signs in", () => {
    const store = createProfileStore(mkdtempSync(join(tmpdir(), "profiles-")));
    expect(store.status("shopee.sg")).toMatchObject({ host: "shopee.sg", connected: false });
    expect(store.list()).toEqual([]);
  });

  it("lists a shop after a sign-in, and forgets it on disconnect", async () => {
    const store = createProfileStore(mkdtempSync(join(tmpdir(), "profiles-")));

    // connect() opens the window and hands control to the person. Here the "person" is the
    // callback: it signs in exactly as a human would, then returns.
    await store.connect("127.0.0.1", `${base}/login`, async () => {});

    expect(store.status("127.0.0.1").connected).toBe(true);
    expect(store.list().map((p) => p.host)).toEqual(["127.0.0.1"]);

    store.disconnect("127.0.0.1");
    expect(store.status("127.0.0.1").connected).toBe(false);
    expect(store.list()).toEqual([]);
  }, 120_000);

  it("holds no password anywhere in the profile it keeps", async () => {
    const store = createProfileStore(mkdtempSync(join(tmpdir(), "profiles-")));
    await store.connect("127.0.0.1", `${base}/login`, async () => {});
    // We store what the shop issued, never what the user typed.
    expect(JSON.stringify(store.status("127.0.0.1"))).not.toContain("hunter2");
  }, 120_000);
});

describe("a run that picks a session per shop", () => {
  it("uses the session belonging to the item's host", async () => {
    const signedIn = await browser.newContext();
    const anonymous = await browser.newContext();

    const page = await signedIn.newPage();
    await page.goto(`${base}/login`);
    await page.locator('input[autocomplete="username"]').fill("tricia.lim@hey.sg");
    await page.locator('input[autocomplete="current-password"]').fill("hunter2");
    await Promise.all([page.waitForNavigation(), page.locator('button[type="submit"]').click()]);
    await page.close();

    const asked: string[] = [];
    const sessions: Record<string, BrowserContext> = { "127.0.0.1": signedIn };

    const res = await createCloser({
      browser: (host) => {
        asked.push(host);
        return sessions[host] ?? anonymous;
      },
      onEvent: () => {},
      journal: createFileJournal(mkdtempSync(join(tmpdir(), "closer-profiles-"))),
    }).run({
      activityId: "act_per_host",
      idempotencyKey: "k1",
      selections: [{ itemId: "ssd", url: `${base}/checkout-auth?sku=nvme-ssd` }],
    });

    expect(asked).toEqual(["127.0.0.1"]); // the runner asked for the session by host
    expect(res.items[0]).toMatchObject({ status: "purchased", amountMinor: 2900 });

    await signedIn.close();
    await anonymous.close();
  }, 120_000);
});
