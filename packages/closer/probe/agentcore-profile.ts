/**
 * Does AgentCore persist authentication across sessions?
 *
 * This matters more than it first sounds. Every marketplace we cannot reach — Shopee, Lazada,
 * Amazon SG — requires an account, and Shopee's own bounce URL says why: `is_logged_in=false`. If a
 * human can log in once through the live view and every later session starts already
 * authenticated, "marketplaces are out" needs revisiting — and the password never touches the
 * agent or a model prompt.
 *
 * The API says yes: `StartBrowserSession` takes `profileConfiguration.profileIdentifier`, described
 * as "persistent data such as cookies and local storage that can be reused across multiple browser
 * sessions", and `SaveBrowserSessionProfile` writes the live session into one.
 *
 * This runs the whole round trip, because the API existing is not the same as it working:
 *
 *   session A -> set a marker cookie -> SaveBrowserSessionProfile -> stop A
 *   session B started WITH that profile -> is the cookie still there?
 *
 * It also answers an ambiguity the types leave open: `SaveBrowserSessionProfile` takes an existing
 * `profileIdentifier` matching `name-XXXXXXXXXX`, and this SDK version exposes no
 * CreateBrowserProfile. So does saving create the profile implicitly, or is there an API we do not
 * have? The probe tries both identifier shapes and reports what the service says.
 *
 * Needs `bedrock-agentcore:SaveBrowserSessionProfile` in the IAM policy — see
 * docs/agentcore-iam-policy.json. Without it this reports AccessDeniedException and stops, which
 * is itself a useful result.
 *
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx probe/agentcore-profile.ts
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx probe/agentcore-profile.ts https://shopee.sg/
 */
import {
  BedrockAgentCoreClient,
  SaveBrowserSessionProfileCommand,
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  BedrockAgentCoreControlClient,
  CreateBrowserProfileCommand,
  ListBrowserProfilesCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { chromium } from "playwright";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { startAgentCoreSession } from "../src/agentcore.js";

const REGION = "ap-southeast-1";
const BROWSER = "aws.browser.v1";
const TARGET = process.argv[2] ?? "https://example.com/";
const MARKER = "happy-profile-marker";

const results: Record<string, unknown> = {};

/** Duplicated from src/agentcore.ts: this probe starts session B by hand to pass the profile. */
async function signedWsHeaders(
  endpoint: string,
  credentials: ReturnType<typeof fromNodeProviderChain>,
) {
  const url = new URL(endpoint);
  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: REGION,
    credentials,
    sha256: Sha256,
  });
  const signed = await signer.sign(
    new HttpRequest({
      method: "GET",
      protocol: "https:",
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { host: url.hostname },
    }),
  );
  return signed.headers as Record<string, string>;
}

async function main() {
  const profileName = process.env.AWS_PROFILE ?? "happy";
  const credentials = fromNodeProviderChain({ profile: profileName });
  const client = new BedrockAgentCoreClient({ region: REGION, credentials });
  // Profiles are created on the CONTROL plane, not the data plane — SaveBrowserSessionProfile only
  // writes into one that already exists, and answers ResourceNotFoundException otherwise.
  const control = new BedrockAgentCoreControlClient({ region: REGION, credentials });

  results.target = TARGET;

  // Reuse a profile across runs where possible; the identifier carries an AWS-assigned suffix, so
  // it cannot simply be hardcoded.
  // Underscores, not hyphens: the service enforces [a-zA-Z][a-zA-Z0-9_]{0,47} on the name, then
  // hands back an identifier with its own hyphenated suffix.
  const PROFILE_NAME = process.env.AGENTCORE_PROFILE_NAME ?? "happy_sg_shopper";
  let profileId: string | null = null;

  const existing = await control.send(new ListBrowserProfilesCommand({})).catch((e) => {
    results.listProfilesError = (e as Error).message;
    return { profileSummaries: [] };
  });
  const match = (existing.profileSummaries ?? []).find((p) => p.name === PROFILE_NAME);
  if (match) {
    profileId = match.profileId ?? null;
    results.profileReused = profileId;
    results.profileLastSavedAt = match.lastSavedAt?.toISOString() ?? null;
  } else {
    const created = await control
      .send(new CreateBrowserProfileCommand({ name: PROFILE_NAME, description: "happy demo" }))
      .catch((e) => {
        results.createProfileError = `${(e as Error).name}: ${(e as Error).message}`;
        return null;
      });
    if (created) {
      profileId = created.profileId ?? null;
      results.profileCreated = profileId;
    }
  }

  if (!profileId) {
    results.verdict = "no profile to work with — see createProfileError";
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // --- session A: leave something behind ---------------------------------------------------------
  const a = await startAgentCoreSession({
    profile: profileName,
    region: REGION,
    sessionTimeoutSeconds: 900,
    name: "happy-profile-a",
  });
  results.sessionA = a.sessionId;

  let savedProfileId: string | null = null;
  try {
    const page = await a.newPage();
    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Stands in for a login cookie. If this survives into a fresh session, a real one would too.
    await page.evaluate((m) => {
      document.cookie = `happy_auth=${m}; path=/; max-age=86400`;
    }, MARKER);
    results.cookieSetInA = await page
      .context()
      .cookies()
      .then((cs) => cs.some((c) => c.name === "happy_auth"));

    try {
      const out = await client.send(
        new SaveBrowserSessionProfileCommand({
          profileIdentifier: profileId,
          browserIdentifier: BROWSER,
          sessionId: a.sessionId,
        }),
      );
      savedProfileId = out.profileIdentifier ?? profileId;
      results.saved = savedProfileId;
    } catch (e) {
      const err = e as Error & { name?: string };
      results.saveError = { name: err.name, message: err.message };
    }
  } finally {
    await a.close().catch(() => {});
  }

  if (!savedProfileId) {
    results.verdict = "could not save a profile — see the save:* entries above";
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // --- session B: start WITH the profile and look for the cookie --------------------------------
  const started = await client.send(
    new StartBrowserSessionCommand({
      browserIdentifier: BROWSER,
      sessionTimeoutSeconds: 900,
      name: "happy-profile-b",
      profileConfiguration: { profileIdentifier: savedProfileId },
    }),
  );
  results.sessionB = started.sessionId;
  const automation = started.streams?.automationStream?.streamEndpoint;
  if (!automation || !started.sessionId) throw new Error("session B returned no endpoint");

  const browser = await chromium.connectOverCDP(automation, {
    headers: await signedWsHeaders(automation, credentials),
  });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("session B exposed no default context");
    const page = await context.newPage();
    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Settle before reading the URL. A bot bounce is a redirect that lands AFTER
    // domcontentloaded, so reading immediately reports the URL we asked for rather than the one we
    // got — which would turn a block into a false pass.
    results.urlAtLoad = page.url();
    await page.waitForTimeout(8000);
    results.urlAfterSettle = page.url();
    results.bounced = /verify|error|sorry|captcha|unavailable/i.test(page.url());

    const cookies = await context.cookies();
    results.cookieSurvivedIntoB = cookies.some(
      (c) => c.name === "happy_auth" && c.value === MARKER,
    );
    results.cookieCountInB = cookies.length;
    results.urlInB = page.url();
    results.verdict = results.cookieSurvivedIntoB
      ? "auth persistence WORKS — log in once, reuse the profile"
      : "profile saved and loaded, but the cookie did not survive";
  } finally {
    await browser.close().catch(() => {});
    await client
      .send(new StopBrowserSessionCommand({ browserIdentifier: BROWSER, sessionId: started.sessionId }))
      .catch(() => {});
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify(results, null, 2));
  console.error("\n" + (e?.stack ?? e));
  process.exit(1);
});
