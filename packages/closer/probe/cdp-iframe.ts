/**
 * Does `connectOverCDP` retain enough fidelity to type a card number into a CROSS-ORIGIN
 * gateway iframe?
 *
 * This is the one question `payWithCard` depends on. Playwright's own docs call
 * `connectOverCDP` "significantly lower fidelity" than its native transport, and AgentCore
 * Browser offers CDP and nothing else. If out-of-process iframes are invisible or unreachable
 * over CDP, `fillFirst`'s `page.frames()` returns only the main frame, every real merchant
 * comes back FIELDS_NOT_FOUND, and the whole AgentCore plan is dead — for free, tonight,
 * instead of at 2am with a live card.
 *
 * `apps/demo-store`'s /checkout-framed does NOT test this: its iframe is same-origin, so it
 * shares the parent's renderer process. The risk lives specifically in Chromium's
 * out-of-process iframes (OOPIF), which only appear across a site boundary. So this probe
 * serves the outer page from `localhost` and the card frame from `127.0.0.1` — different sites
 * to Chromium — and forces `--site-per-process` so the split is guaranteed rather than hoped for.
 *
 * No AWS, no card, no money. Junk PAN.
 *
 *   pnpm --filter @happy/closer exec tsx probe/cdp-iframe.ts
 */
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

const OUTER_PORT = 4031;
const INNER_PORT = 4032;
const CDP_PORT = 9222;
const JUNK_PAN = "4242424242424242";

const OUTER_HOST = "localhost";
const INNER_HOST = "127.0.0.1";

/** Mirrors demo-store's /checkout-framed markup, but points the frame at a different site. */
const outerHtml = `<!doctype html><meta charset="utf-8"><title>Checkout</title>
<h1>Checkout — probe</h1>
<form method="post" action="/newsletter">
  <label>Email <input name="email" type="email"></label>
  <button type="submit">Subscribe</button>
</form>
<p data-total-cents="1200">Total: S$12.00</p>
<iframe title="card" src="http://${INNER_HOST}:${INNER_PORT}/card-frame" width="400" height="220"></iframe>
<form method="post" action="/checkout">
  <button type="submit">Pay now</button>
</form>`;

/** The gateway document: card fields only, no submit button — the split that breaks page locators. */
const innerHtml = `<!doctype html><meta charset="utf-8"><title>card</title>
<label>Card number <input name="number" autocomplete="cc-number"></label>
<label>Expiry <input name="expiry" autocomplete="cc-exp"></label>
<label>CVC <input name="verification_value" autocomplete="cc-csc"></label>
<label>Name <input name="name" autocomplete="cc-name"></label>`;

function serve(port: number, host: string, body: string): Promise<Server> {
  const s = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  return new Promise((resolve) => s.listen(port, host, () => resolve(s)));
}

const results: Record<string, unknown> = {};

async function main() {
  const outer = await serve(OUTER_PORT, OUTER_HOST, outerHtml);
  const inner = await serve(INNER_PORT, INNER_HOST, innerHtml);

  // Launch a plain Chromium with a CDP port and connect the way AgentCore forces us to. The
  // transport differs (AgentCore wraps CDP in a SigV4-signed websocket) but the protocol and
  // therefore the frame fidelity are identical, which is what is under test here.
  const launched = await chromium.launch({
    args: [`--remote-debugging-port=${CDP_PORT}`, "--site-per-process"],
  });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  try {
    // The default context, never browser.newContext() — AgentCore's managed browser has one
    // context and creating another is what the investigation doc warns against.
    const context = browser.contexts()[0];
    results.contextCount = browser.contexts().length;
    if (!context) throw new Error("connectOverCDP exposed no default context");

    const page = await context.newPage();
    await page.goto(`http://${OUTER_HOST}:${OUTER_PORT}/`, { waitUntil: "load" });
    await page.waitForTimeout(500);

    // 1. Are the child frames visible at all over CDP? This is fillFirst's exact expression.
    const children = page.frames().filter((f) => f !== page.mainFrame());
    results.frameCount = page.frames().length;
    results.childFrameUrls = children.map((f) => f.url());
    results.crossOriginChildSeen = children.some((f) => f.url().includes(`${INNER_HOST}:${INNER_PORT}`));

    // 2. Confirm Chromium really put it out of process, otherwise this probe proved nothing.
    results.oopif = await page
      .evaluate(() => {
        const f = document.querySelector("iframe") as HTMLIFrameElement | null;
        // A same-process frame exposes contentDocument; an OOPIF throws or returns null.
        try {
          return f?.contentDocument === null;
        } catch {
          return true;
        }
      })
      .catch(() => "evaluate-failed");

    // 3. The real test: type into the cross-origin field the way payWithCard does.
    let typed: string | null = null;
    let hitSelector: string | null = null;
    for (const scope of [page, ...children]) {
      const el = scope.locator('input[autocomplete="cc-number"]').first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        hitSelector = 'input[autocomplete="cc-number"]';
        await el.click();
        await el.pressSequentially(JUNK_PAN, { delay: 5 });
        // Read it back from inside the frame — proving the keystrokes landed in the document,
        // not merely that the call returned without throwing.
        typed = await el.inputValue();
        break;
      }
    }
    results.fieldFound = hitSelector !== null;
    results.digitsLanded = typed === JUNK_PAN;
    results.readBackLength = typed?.length ?? 0;

    // 4. Free answers while we are here.
    results.navigatorWebdriver = await page.evaluate(() => navigator.webdriver);
    results.userAgent = await page.evaluate(() => navigator.userAgent);

    await page.close();
  } finally {
    await browser.close();
    await launched.close();
    outer.close();
    inner.close();
  }

  console.log(JSON.stringify(results, null, 2));

  const ok = results.crossOriginChildSeen === true && results.digitsLanded === true;
  console.log(ok ? "\nPASS — CDP reaches cross-origin card fields." : "\nFAIL — see results above.");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
