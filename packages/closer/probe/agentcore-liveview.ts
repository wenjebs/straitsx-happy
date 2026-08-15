/**
 * Is the presigned live-view URL something you can just open in Chrome, or does it need a client?
 *
 * The investigation established the URL exists, is SigV4-presigned and caps at 300 seconds. It did
 * not establish whether pasting it into a browser renders a screen. That decides how an operator
 * actually takes over during a 3DS challenge: paste a link, or open the AWS console.
 *
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx probe/agentcore-liveview.ts
 */
import { startAgentCoreSession } from "../src/agentcore.js";

const results: Record<string, unknown> = {};

async function main() {
  const session = await startAgentCoreSession({
    profile: process.env.AWS_PROFILE ?? "happy",
    region: "ap-southeast-1",
    sessionTimeoutSeconds: 300,
    name: "happy-probe-liveview",
  });
  results.sessionId = session.sessionId;

  try {
    const page = await session.newPage();
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });

    const url = await session.liveViewUrl(300);
    results.queryParams = [...new URL(url).searchParams.keys()];

    // A plain GET, the way a browser would open it.
    const res = await fetch(url, { redirect: "manual" });
    results.status = res.status;
    results.contentType = res.headers.get("content-type");
    results.location = res.headers.get("location");
    const body = await res.text().catch(() => "");
    results.bodyStart = body.slice(0, 300);
    results.looksLikeHtml = /^\s*<(!doctype|html)/i.test(body);

    // And as a websocket upgrade, which is what DCV would do.
    const upgrade = await fetch(url, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    }).catch((e) => ({ status: `fetch error: ${e.message}` }) as { status: string });
    results.upgradeStatus = (upgrade as Response).status;
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
