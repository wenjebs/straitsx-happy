/**
 * Is a human handoff survivable?
 *
 * probe/agentcore-decisions.ts established that `streamStatus=DISABLED` tears down the open CDP
 * socket — our `Page` dies the instant we hand the keyboard over. That leaves exactly two possible
 * designs, and this probe decides between them:
 *
 *   DESIGN A — disable, human acts, re-enable, RECONNECT. Viable only if the remote Chrome keeps
 *              its tabs and cookies across the socket dying, so that reconnecting lands us back on
 *              the same checkout rather than a blank browser. If it does, the agent is genuinely
 *              locked out while the human types, which is the safer story.
 *
 *   DESIGN B — never disable at all. The live view is a real keyboard whether or not automation is
 *              enabled (only the automation stream has a streamStatus), so a human can simply act
 *              while we idle and poll. AWS's own captcha sample takes this route.
 *
 * The measurement: park on a distinctive page, disable, re-enable, reconnect, and see whether the
 * tab and its state survived.
 *
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx probe/agentcore-handoff.ts
 */
import { startAgentCoreSession } from "../src/agentcore.js";

const MARKER = "happy-handoff-marker";

const results: Record<string, unknown> = {};

async function main() {
  const session = await startAgentCoreSession({
    profile: process.env.AWS_PROFILE ?? "happy",
    region: "ap-southeast-1",
    sessionTimeoutSeconds: 900,
    name: "happy-probe-handoff",
  });
  results.sessionId = session.sessionId;

  try {
    const page = await session.newPage();
    // Prove cookie + storage survival, not merely that a tab exists — a checkout that loses its
    // cart cookie across a handoff is as dead as one that loses its tab.
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.evaluate((m) => {
      document.cookie = `happy=${m}; path=/`;
      window.sessionStorage.setItem("happy", m);
      document.title = m;
    }, MARKER);
    results.parkedUrl = page.url();
    results.parkedTitle = await page.title();

    // --- hand the keyboard over ---------------------------------------------------------------
    await session.setAutomationEnabled(false);
    results.disableReturned = true;
    await new Promise((r) => setTimeout(r, 3000));
    results.browserConnectedWhileDisabled = session.browser.isConnected();

    // --- take it back -------------------------------------------------------------------------
    await session.setAutomationEnabled(true);
    results.enableReturned = true;
    await new Promise((r) => setTimeout(r, 3000));

    await session.reconnect();
    results.reconnected = true;

    const pages = session.pages();
    results.pageCountAfterReconnect = pages.length;
    results.urlsAfterReconnect = pages.map((p) => p.url());

    const same = pages.find((p) => p.url().includes("example.com"));
    results.sameTabFound = Boolean(same);
    if (same) {
      results.titleAfterReconnect = await same.title().catch((e) => `error: ${e.message}`);
      results.sessionStorageSurvived = await same
        .evaluate(() => window.sessionStorage.getItem("happy"))
        .catch((e) => `error: ${e.message}`);
      results.cookiesSurvived = await same
        .context()
        .cookies()
        .then((cs) => cs.some((c) => c.name === "happy"))
        .catch((e) => `error: ${e.message}`);
      // And can we still drive it? This is what confirm() needs after a handoff.
      results.navigableAfterReconnect = await same
        .goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30_000 })
        .then(() => true)
        .catch((e) => `error: ${e.message}`);
    }
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
