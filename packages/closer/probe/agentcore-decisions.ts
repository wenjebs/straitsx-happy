/**
 * The two remaining AgentCore unknowns, in one session to keep the cost to a fraction of a cent.
 *
 * A. THE DECISION TEST. Does `UpdateBrowserStream` with `streamStatus=DISABLED` tear down an
 *    already-open CDP socket? No AWS doc, SDK docstring or sample says. It matters because
 *    DISABLED is how you hand the keyboard to a human — and if it also kills our `Page`, it kills
 *    it at the exact moment we hand off for 3DS, on a card with ten minutes to live. A dead Page
 *    means no confirm(), which means TIMEOUT, cancel, and a STRANDED card.
 *
 * B. THE IFRAME TEST, over the real transport. `probe/cdp-iframe.ts` already proved
 *    `connectOverCDP` reaches an out-of-process cross-origin iframe against a local Chromium.
 *    This repeats it through AgentCore's SigV4 websocket. AgentCore's browser cannot reach this
 *    machine's loopback, so the frame is injected pointing at a public site that permits framing.
 *
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx probe/agentcore-decisions.ts
 */
import { startAgentCoreSession } from "../src/agentcore.js";

const FRAME_SRC = "https://www.openstreetmap.org/export/embed.html?bbox=103.8,1.28,103.9,1.32";

const results: Record<string, unknown> = {};

async function main() {
  const session = await startAgentCoreSession({
    profile: process.env.AWS_PROFILE ?? "happy",
    region: "ap-southeast-1",
    sessionTimeoutSeconds: 900,
    name: "happy-probe-decisions",
  });
  results.sessionId = session.sessionId;

  try {
    const page = await session.newPage();
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });

    // --- B. cross-origin iframe over the real transport ---------------------------------------
    await page.evaluate((src) => {
      const f = document.createElement("iframe");
      f.src = src;
      f.width = "500";
      f.height = "350";
      document.body.appendChild(f);
    }, FRAME_SRC);
    await page.waitForTimeout(6000);

    const children = page.frames().filter((f) => f !== page.mainFrame());
    results.frameCount = page.frames().length;
    results.childFrameHosts = children.map((f) => {
      try {
        return new URL(f.url()).host;
      } catch {
        return f.url().slice(0, 60);
      }
    });
    results.crossOriginFrameSeen = children.some((f) => f.url().includes("openstreetmap.org"));

    // Really out of process? If the parent can read contentDocument it shared a renderer and this
    // proved nothing about OOPIF.
    results.oopif = await page.evaluate(() => {
      const f = document.querySelector("iframe") as HTMLIFrameElement | null;
      try {
        return f?.contentDocument === null;
      } catch {
        return true;
      }
    });

    // Can we actually reach INTO it — the thing payWithCard does.
    const child = children.find((f) => f.url().includes("openstreetmap.org"));
    if (child) {
      results.frameReachable = await child
        .locator("body")
        .count()
        .then((n) => n > 0)
        .catch((e) => `error: ${e.message}`);
      results.frameTitle = await child.title().catch((e) => `error: ${e.message}`);
    }

    // --- A. the decision test -----------------------------------------------------------------
    results.beforeDisable = await page.title().catch((e) => `error: ${e.message}`);

    await session.setAutomationEnabled(false);
    await page.waitForTimeout(3000);

    // If DISABLED tears down the socket, these throw. That is the answer we need before wiring a
    // human handoff into the money path.
    results.pageStillConnected = page.isClosed() === false;
    results.browserStillConnected = session.browser.isConnected();
    results.titleWhileDisabled = await page.title().catch((e) => `error: ${e.message}`);
    results.evalWhileDisabled = await page
      .evaluate(() => document.location.href)
      .catch((e) => `error: ${e.message}`);
    // Can automation still ACT while disabled, or is it read-only? Both answers are useful: if
    // input is blocked but reads work, DISABLED is a safe way to stop the agent fighting a human
    // for the keyboard.
    results.clickWhileDisabled = await page
      .evaluate(() => {
        document.title = "written-while-disabled";
        return document.title;
      })
      .catch((e) => `error: ${e.message}`);

    await session.setAutomationEnabled(true);
    await page.waitForTimeout(3000);
    results.titleAfterReEnable = await page.title().catch((e) => `error: ${e.message}`);
    results.browserConnectedAfterReEnable = session.browser.isConnected();
  } finally {
    await session.close().catch((e) => {
      results.closeError = e.message;
    });
    results.sessionStopped = true;
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify(results, null, 2));
  console.error("\n" + (e?.stack ?? e));
  process.exit(1);
});
