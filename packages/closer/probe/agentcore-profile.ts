/**
 * Does AgentCore persist authentication across sessions?
 *
 * This matters more than it first sounds. Every marketplace we cannot reach — Shopee, Lazada,
 * Amazon SG, FairPrice — requires an account, and Shopee's own bounce URL says why:
 * `is_logged_in=false`. If a human can log in once through the live view and every later session
 * starts already authenticated, the whole "marketplaces are out" conclusion needs revisiting, and
 * the password never touches the agent or a model prompt.
 *
 * The API says yes: `StartBrowserSession` takes `profileConfiguration.profileIdentifier`, described
 * as "persistent data such as cookies and local storage that can be reused across multiple browser
 * sessions", and `SaveBrowserSessionProfile` writes the live session into one.
 *
 * What is NOT obvious from the types is where a profile comes from. `SaveBrowserSessionProfile`
 * takes an existing `profileIdentifier` matching `name-XXXXXXXXXX`, and this SDK version exposes no
 * CreateBrowserProfile. So this probe answers, empirically: is the profile created implicitly by
 * saving, or does it need an API we do not have?
 *
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx probe/agentcore-profile.ts
 */
import {
  BedrockAgentCoreClient,
  SaveBrowserSessionProfileCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { startAgentCoreSession } from "../src/agentcore.js";

const REGION = "ap-southeast-1";
const MARKER = "happy-profile-marker";

const results: Record<string, unknown> = {};

async function main() {
  const profile = process.env.AWS_PROFILE ?? "happy";
  const client = new BedrockAgentCoreClient({
    region: REGION,
    credentials: fromNodeProviderChain({ profile }),
  });

  const session = await startAgentCoreSession({
    profile,
    region: REGION,
    sessionTimeoutSeconds: 600,
    name: "happy-probe-profile",
  });
  results.sessionId = session.sessionId;

  try {
    const page = await session.newPage();
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Stand in for a login cookie. If this survives into a fresh session, so would a real one.
    await page.evaluate((m) => {
      document.cookie = `happy_auth=${m}; path=/; max-age=86400`;
    }, MARKER);
    results.cookieSet = await page
      .context()
      .cookies()
      .then((cs) => cs.some((c) => c.name === "happy_auth"));

    // Try to save. Two plausible outcomes, both informative: it creates the profile implicitly, or
    // it rejects an identifier that does not exist yet and names the API we are missing.
    for (const candidate of ["happy-sg-shopper", "happysgshopper-a1b2c3d4e5"]) {
      try {
        const out = await client.send(
          new SaveBrowserSessionProfileCommand({
            profileIdentifier: candidate,
            browserIdentifier: "aws.browser.v1",
            sessionId: session.sessionId,
          }),
        );
        results[`save:${candidate}`] = { ok: true, profileIdentifier: out.profileIdentifier };
      } catch (e) {
        const err = e as Error & { name?: string };
        results[`save:${candidate}`] = { ok: false, name: err.name, message: err.message };
      }
    }
  } finally {
    await session.close().catch(() => {});
    results.sessionStopped = true;
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify(results, null, 2));
  console.error("\n" + (e?.stack ?? e));
  process.exit(1);
});
