/**
 * A two-item purchase run, start to finish, with nothing mocked but the issuer.
 *
 *   pnpm --filter @happy/closer demo
 *
 * Starts its own demo store, opens a real browser, and prints the log lines the UI would render.
 * ISSUER=mock by default: no money moves. Everything else — the mandate, the reservation, the
 * card, the autofill, the order — is the real path.
 */
import { app } from "@happy/demo-store/app";
import * as pay from "@happy/pay";
import { serve } from "@hono/node-server";
import { chromium } from "playwright";
import { createCloser } from "../src/runner.js";

const PORT = Number(process.env.DEMO_PORT ?? 4036);
const base = `http://127.0.0.1:${PORT}`;

// Hard-set, not defaulted: the repo's .env carries ISSUER=straitsx for live rehearsals, and this
// script must never inherit it. A live purchase is a deliberate act, not something a demo does.
process.env.ISSUER = "mock";
process.env.SPEND_PRIVATE_KEY = "";
process.env.DATABASE_URL = ":memory:";
// The repo's .env may clamp MAX_CARD_CENTS well below the rail's S$30 as a live-rehearsal safety
// (it reads 500 today). That clamp is right for real money and wrong for an offline demo.
process.env.MIN_CARD_CENTS = "500";
process.env.MAX_CARD_CENTS = "3000";
process.env.CARD_API_BASE ??= "https://card.straitsx.ai/sandbox/cardapi";
process.env.ALLOWED_NETWORK ??= "eip155:43113";
process.env.CHAIN_ID ??= "43113";
process.env.RPC_URL ??= "https://api.avax-test.network/ext/bc/C/rpc";
process.env.XSGD_ADDRESS ??= "0xd769410dc8772695a7f55a304d2125320a65c2a5";

// A window you can watch is the point of this script. slowMo spaces the clicks and the keystrokes
// out; without it the whole run is over in under a second and there is nothing to see.
// HEADLESS=1 turns the window off. DEMO_SLOWMO=0 runs it at full speed.
const headless = process.env.HEADLESS === "1";
const slowMo = Number(process.env.DEMO_SLOWMO ?? 500);

const server = serve({ fetch: app.fetch, port: PORT });
const browser = await chromium.launch({ headless, slowMo });

await pay.createMandate({
  perItemCents: 3000,
  dailyCents: 15000,
  merchants: ["127.0.0.1"],
  expiresAt: new Date(Date.now() + 86_400_000),
});

// The Closer closes each item's page as soon as the order lands, which is correct and leaves the
// "Order confirmed" page on screen for a blink. Hold it open a moment instead — demo only, and it
// needs no change in the runner, because BrowserLike is just { newPage() }.
const linger = Number(process.env.DEMO_LINGER_MS ?? 2500);
const watchable = {
  async newPage() {
    const page = await browser.newPage();
    const close = page.close.bind(page);
    page.close = async () => {
      await page.waitForTimeout(linger).catch(() => {});
      await close();
    };
    return page;
  },
};

const closer = createCloser({
  browser: headless ? browser : watchable,
  journal: { read: () => null, write: () => {} }, // a demo run never resumes
  onEvent: (e) => {
    if (e.type === "log.line") console.log(`  ${e.line.ts}  ${e.line.tag.padEnd(3)}  ${e.line.text}`);
    if (e.type === "exec.step") console.log(`         step ${e.row.step}/4  ${e.row.itemId} ${e.row.state}`);
  },
});

console.log(
  `\nISSUER=mock — no money moves. Buying two items from ${base}` +
    `\n${headless ? "headless" : "headed"} browser, slowMo ${slowMo}ms\n`,
);
const result = await closer.run({
  activityId: "act_demo",
  idempotencyKey: "demo-1",
  selections: [
    { itemId: "hub", tag: "HUB", hueIndex: 0, url: `${base}/item/usb-c-hub`, itemName: "Anker USB-C Hub" },
    { itemId: "ssd", tag: "SSD", hueIndex: 1, url: `${base}/item/nvme-ssd`, itemName: "1TB NVMe SSD" },
  ],
});

const mandate = await pay.getMandate();
console.log(`\n${JSON.stringify(result, null, 2)}\n`);
console.log(`mandate spent: ${mandate?.spentCents} cents · run total: ${result.totalMinor} cents\n`);

pay.shutdown();
await browser.close();
server.close();
