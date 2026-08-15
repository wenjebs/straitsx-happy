/**
 * AWS Bedrock AgentCore Browser as the browser layer.
 *
 * The whole point of this file is that it is the ONLY file in the repo that talks to AWS. What it
 * returns satisfies `BrowserLike` — `{ newPage(): Promise<Page> }` — so the runner, the journal,
 * idempotency, the mandate check and the failure ladder all work unchanged. This is a
 * substitution, not a refactor.
 *
 * Why AgentCore at all, over driving a local Chromium:
 *
 *   1. Its automation endpoint is plain CDP, so `payWithCard` types the card exactly as it does
 *      today and the number still never reaches a model. Verified: `probe/cdp-iframe.ts` proves
 *      `connectOverCDP` reaches a genuine out-of-process cross-origin iframe, which is what every
 *      PCI-compliant gateway serves the card field from.
 *   2. Its live view lets a human take the keyboard mid-session, in the same Chrome with cookies
 *      intact. That is the only answer we have to a captcha, an SMS code or a 3-D Secure
 *      challenge — the wall no automation gets past, and the one that otherwise strands a card.
 *
 * What it does NOT fix: egress is an AWS datacentre IP and AWS publishes every range publicly, so
 * a merchant classifies us as datacentre before a line of page JS runs. Build for "a human clears
 * the challenge", not for evasion.
 */
import { Sha256 } from "@aws-crypto/sha256-js";
import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
  UpdateBrowserStreamCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { type Browser, chromium, type Page } from "playwright";

const SERVICE = "bedrock-agentcore";

/** Avoids a direct @smithy/types dependency for one type. */
type CredentialProvider = ReturnType<typeof fromNodeProviderChain>;

/** The managed browser. Deliberately never a custom one — see `close()`'s note on recording. */
const MANAGED_BROWSER_ID = "aws.browser.v1";

/** AWS's hard cap on a presigned live-view URL. Longer is silently rejected. */
const LIVE_VIEW_MAX_SECONDS = 300;

export type AgentCoreOptions = {
  region?: string;
  /** Named profile. Defaults to AWS_PROFILE, since this machine's `default` is a Scaleway one. */
  profile?: string;
  /** Session lifetime. The docs contradict themselves on the default, so we always pass it. */
  sessionTimeoutSeconds?: number;
  /** Shows up in the console session list. Handy when several runs are in flight. */
  name?: string;
};

export type AgentCoreSession = {
  /** The `BrowserLike` the runner wants. Pages come from the DEFAULT context — see newPage(). */
  newPage(): Promise<Page>;
  readonly sessionId: string;
  /** The raw Playwright Browser, for the rare caller that needs more than a page. Replaced by
   *  `reconnect()`, so read it fresh rather than holding a reference across a handoff. */
  readonly browser: Browser;
  /**
   * Mints a presigned live-view URL, valid for at most 300 seconds.
   *
   * DANGER: this streams rendered pixels. Whoever holds the URL sees the card number the instant
   * it is typed, and the stream CANNOT be made read-only — only the automation stream has a
   * `streamStatus`, so the URL is a live keyboard on the payment form. Mint it only AFTER submit,
   * only for a trusted operator, and never leave a viewer attached during card entry.
   */
  liveViewUrl(expiresInSeconds?: number): Promise<string>;
  /** Hands keyboard control to the human, or takes it back. See the warning on the function. */
  setAutomationEnabled(enabled: boolean): Promise<void>;
  /**
   * Re-attaches CDP to the SAME AgentCore session after the socket has gone away.
   *
   * `setAutomationEnabled(false)` kills the socket (measured — see probe/agentcore-decisions.ts),
   * so this is the only way back from a deliberate handoff. The remote Chrome, its tabs and its
   * cookies live on the AWS side and are untouched by the socket dying, so reconnecting returns
   * the same browsing session rather than a fresh one.
   */
  reconnect(): Promise<void>;
  /** Pages currently open in the remote browser's default context. */
  pages(): Page[];
  close(): Promise<void>;
};

/**
 * Signs a GET for the CDP websocket and returns the headers Playwright should send on the upgrade.
 *
 * AgentCore's automation endpoint is CDP wrapped in a SigV4-signed websocket. Playwright's
 * `connectOverCDP` takes arbitrary headers, which is exactly the hook we need — nothing about the
 * protocol below the transport changes, which is why frame fidelity is unaffected.
 */
async function signedWsHeaders(
  endpoint: string,
  region: string,
  credentials: CredentialProvider,
): Promise<Record<string, string>> {
  const url = new URL(endpoint);
  const signer = new SignatureV4({
    service: SERVICE,
    region,
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

export async function startAgentCoreSession(
  opts: AgentCoreOptions = {},
): Promise<AgentCoreSession> {
  const region = opts.region ?? process.env.AWS_REGION ?? "ap-southeast-1";
  const profile = opts.profile ?? process.env.AWS_PROFILE;
  const credentials = fromNodeProviderChain(profile ? { profile } : {});

  const client = new BedrockAgentCoreClient({ region, credentials });

  const started = await client.send(
    new StartBrowserSessionCommand({
      browserIdentifier: MANAGED_BROWSER_ID,
      sessionTimeoutSeconds: opts.sessionTimeoutSeconds ?? 900,
      name: opts.name,
    }),
  );

  const sessionId = started.sessionId;
  const automation = started.streams?.automationStream?.streamEndpoint;
  const liveView = started.streams?.liveViewStream?.streamEndpoint;
  if (!sessionId || !automation) {
    throw new Error("AgentCore returned no sessionId or automation endpoint");
  }

  const connect = async () =>
    chromium.connectOverCDP(automation, {
      headers: await signedWsHeaders(automation, region, credentials),
    });

  let browser: Browser;
  try {
    browser = await connect();
  } catch (e) {
    // A session we cannot drive is a session that must not keep billing.
    await client
      .send(new StopBrowserSessionCommand({ browserIdentifier: MANAGED_BROWSER_ID, sessionId }))
      .catch(() => {});
    throw e;
  }

  const defaultContext = () => {
    // The DEFAULT context, never browser.newContext(). AgentCore's managed browser owns one
    // context; a second one is not the session AWS is streaming to the live view, so a human
    // taking over would be looking at a different window than the agent is driving.
    const context = browser.contexts()[0];
    if (!context) throw new Error("AgentCore CDP session exposed no default context");
    return context;
  };

  return {
    sessionId,
    get browser() {
      return browser;
    },

    async newPage() {
      return defaultContext().newPage();
    },

    pages() {
      return defaultContext().pages();
    },

    async reconnect() {
      await browser.close().catch(() => {});
      browser = await connect();
    },

    async liveViewUrl(expiresInSeconds = LIVE_VIEW_MAX_SECONDS) {
      if (!liveView) throw new Error("this session has no live-view endpoint");
      const url = new URL(liveView);
      const signer = new SignatureV4({ service: SERVICE, region, credentials, sha256: Sha256 });
      const presigned = await signer.presign(
        new HttpRequest({
          method: "GET",
          protocol: "https:",
          hostname: url.hostname,
          path: url.pathname,
          headers: { host: url.hostname },
        }),
        { expiresIn: Math.min(expiresInSeconds, LIVE_VIEW_MAX_SECONDS) },
      );
      const out = new URL(`https://${presigned.hostname}${presigned.path}`);
      for (const [k, v] of Object.entries(presigned.query ?? {})) {
        out.searchParams.set(k, String(v));
      }
      return out.toString();
    },

    /**
     * DISABLED hands the keyboard to whoever holds the live-view URL; ENABLED takes it back.
     *
     * Whether DISABLED also tears down an already-open CDP socket is undocumented — no AWS doc,
     * SDK docstring or sample says. If it does, our `Page` handle dies at the exact moment we hand
     * off for 3DS, on a card with ten minutes to live. `probe/agentcore-disable.ts` answers it.
     * Until it answers yes, prefer not calling this at all: AWS's own captcha sample never does,
     * and a human can type into the live view while automation stays enabled.
     */
    async setAutomationEnabled(enabled: boolean) {
      await client.send(
        new UpdateBrowserStreamCommand({
          browserIdentifier: MANAGED_BROWSER_ID,
          sessionId,
          streamUpdate: {
            automationStreamUpdate: { streamStatus: enabled ? "ENABLED" : "DISABLED" },
          },
        }),
      );
    },

    async close() {
      // Stop explicitly rather than waiting out the TTL — the TTL is billed.
      await browser.close().catch(() => {});
      await client.send(
        new StopBrowserSessionCommand({ browserIdentifier: MANAGED_BROWSER_ID, sessionId }),
      );
    },
  };
}
