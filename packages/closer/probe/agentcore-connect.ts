/**
 * End-to-end probe of the AgentCore session layer. Costs a fraction of a cent and no card.
 *
 * Answers, in one run:
 *   1. Does `connectOverCDP` accept a SigV4-signed websocket at all?
 *   2. Does the default context exist, so `newPage()` works without `browser.newContext()`?
 *   3. Does the egress geolocate to Singapore, or somewhere a merchant will mismatch against an
 *      SG card? (Stripe Radar's canonical rule is `Block if :card_country: != :ip_country:`.)
 *   4. Does AgentCore's Chrome set `navigator.webdriver`? Locally that flag is Playwright's own
 *      doing, so this is the first honest reading.
 *   5. Can it fill a cross-origin gateway iframe — re-run of probe/cdp-iframe.ts's question, but
 *      against the real transport this time, using a public test page rather than localhost
 *      (AgentCore's browser cannot reach this machine's loopback).
 *
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx probe/agentcore-connect.ts
 */
import { startAgentCoreSession } from "../src/agentcore.js";

const results: Record<string, unknown> = {};

async function main() {
  const session = await startAgentCoreSession({
    profile: process.env.AWS_PROFILE ?? "happy",
    region: "ap-southeast-1",
    sessionTimeoutSeconds: 900,
    name: "happy-probe-connect",
  });
  results.sessionId = session.sessionId;
  results.cdpConnected = true;
  results.contextCount = session.browser.contexts().length;

  try {
    const page = await session.newPage();
    results.newPageOk = true;

    // 3 + 4. Where does the traffic come from, and does the browser announce itself?
    await page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded", timeout: 30_000 });
    const geo = await page.evaluate(() => document.body.innerText);
    try {
      const parsed = JSON.parse(geo);
      results.egressIp = parsed.ip;
      results.egressCountry = parsed.country;
      results.egressRegion = parsed.region;
      results.egressOrg = parsed.org;
    } catch {
      results.egressRaw = geo.slice(0, 200);
    }

    results.navigatorWebdriver = await page.evaluate(() => navigator.webdriver);
    results.userAgent = await page.evaluate(() => navigator.userAgent);

    // 5. Cross-origin iframe over the real transport. Stripe's own hosted element page serves the
    // card field from js.stripe.com — a genuine cross-site frame, and no card is entered here.
    await page.goto("https://checkout.stripe.dev/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(4000);
    const frames = page.frames().filter((f) => f !== page.mainFrame());
    results.frameCount = page.frames().length;
    results.crossOriginFrameHosts = [
      ...new Set(
        frames
          .map((f) => {
            try {
              return new URL(f.url()).host;
            } catch {
              return f.url().slice(0, 40);
            }
          })
          .filter((h) => h && h !== "checkout.stripe.dev"),
      ),
    ];

    // 6. Can we mint a live-view URL? Do NOT open it — nothing sensitive is on screen, but the
    // habit of minting only after submit is the one that keeps the PAN off a stranger's monitor.
    const url = await session.liveViewUrl(300);
    results.liveViewMinted = url.startsWith("https://");
    results.liveViewSigned = url.includes("X-Amz-Signature");
    results.liveViewExpires = new URL(url).searchParams.get("X-Amz-Expires");
  } finally {
    await session.close();
    results.sessionStopped = true;
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify(results, null, 2));
  console.error("\n" + (e?.stack ?? e));
  process.exit(1);
});
