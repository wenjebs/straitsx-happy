/**
 * Opens a real AgentCore browser session, parks it on a page, and hands you the keyboard.
 *
 * This is the demo of the one thing AgentCore buys us that nothing else does: a human can take
 * over mid-session, in the same Chrome, with cookies intact — which is the only answer to a
 * captcha, an SMS code or a 3-D Secure challenge.
 *
 * It stays running and prints what the browser is doing every few seconds, so you can watch your
 * own clicks land. Ctrl-C stops the session (and stops the billing).
 *
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx demo/agentcore-live.ts
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx demo/agentcore-live.ts https://example.com
 *
 * Take control through the AWS console's live view. The presigned live-view URL is NOT a web page
 * — measured, it answers `501 Not Implemented` to a plain GET, because it is an Amazon DCV
 * transport endpoint expecting a DCV client to speak to it. The console embeds that client; a
 * browser address bar does not. See probe/agentcore-liveview.ts.
 *
 * NOTE: the live view streams rendered pixels and CANNOT be made read-only. Whoever holds that URL
 * has a live keyboard on whatever is on screen. Never leave a viewer attached while a card number
 * is being typed.
 */
import { startAgentCoreSession } from "../src/agentcore.js";

const REGION = "ap-southeast-1";
const TARGET = process.argv[2] ?? "https://www.google.com/";
/** Long enough to click around in the console without the session dying under you. */
const SESSION_SECONDS = 1800;

async function main() {
  const session = await startAgentCoreSession({
    profile: process.env.AWS_PROFILE ?? "happy",
    region: REGION,
    sessionTimeoutSeconds: SESSION_SECONDS,
    name: "happy-live-demo",
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write("\n\nstopping session…\n");
    await session.close().catch((e) => console.error("close failed:", e.message));
    console.log("stopped. billing ended.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const page = await session.newPage();
  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => {
    console.error(`initial navigation failed (the session is still usable): ${e.message}`);
  });

  const consoleUrl =
    `https://${REGION}.console.aws.amazon.com/bedrock-agentcore/home?region=${REGION}`;

  console.log(`
──────────────────────────────────────────────────────────────────────────────
  session   ${session.sessionId}
  parked on ${TARGET}
  expires   in ${SESSION_SECONDS / 60} minutes unless you Ctrl-C sooner

  TAKE CONTROL
    ${consoleUrl}
    → Built-in tools → Browser → session "happy-live-demo" → live view

    Sign in as your normal admin user; happy-agentcore is CLI-only by design.
    You get a real keyboard and mouse. Type, click, solve a captcha — this
    process keeps watching and prints every page change below.
──────────────────────────────────────────────────────────────────────────────
`);

  // Watch what the browser is doing, so your clicks show up here. This is read-only observation —
  // the agent is not fighting you for the keyboard.
  let lastLine = "";
  const watcher = setInterval(async () => {
    if (stopping) return;
    try {
      const pages = session.pages().filter((p) => !p.url().startsWith("chrome://"));
      const active = pages[pages.length - 1];
      if (!active) return;
      const line = `${active.url()}  —  ${await active.title()}`;
      if (line !== lastLine) {
        lastLine = line;
        console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
      }
    } catch (e) {
      console.log(`[watch] ${(e as Error).message}`);
    }
  }, 3000);

  // Keep the process alive until Ctrl-C.
  await new Promise(() => {});

  clearInterval(watcher);
}

main().catch(async (e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
