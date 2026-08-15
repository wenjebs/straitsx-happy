import { Sha256 } from "@aws-crypto/sha256-js";
import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { FrameHub } from "../streams.js";

/**
 * One AgentCore browser session, wrapped.
 *
 * Everything AWS-specific in the search path lives here. The rest of the backend sees a Playwright
 * `Page` and an MJPEG channel id.
 *
 * Two constraints from probing the service, both load-bearing:
 *
 * 1. The automation endpoint accepts a SigV4 **presigned query URL** on the WebSocket handshake
 *    (101), which is what `connectOverCDP` can carry. Signed headers work too, but presigning keeps
 *    the credential handling in one place.
 * 2. Exactly one connection per session — a second returns
 *    `429 Too many connections`. So the screencast shares the connection the scout drives with,
 *    via a CDP session on the same page, rather than dialing in separately.
 */
export interface AgentCoreOptions {
  region: string;
  browserIdentifier: string;
  sessionTimeoutSeconds: number;
  /** Tile size. Small frames keep four concurrent streams cheap and legible. */
  viewport: { width: number; height: number };
  frames: FrameHub;
  jpegQuality: number;
}

export interface BrowserSession {
  sessionId: string;
  page: Page;
  /** Ends the screencast, closes CDP, and stops the AgentCore session so billing stops. */
  close(): Promise<void>;
}

export class AgentCoreBrowser {
  private readonly control: BedrockAgentCoreClient;
  private readonly signer: SignatureV4;
  private readonly host: string;

  constructor(private readonly options: AgentCoreOptions) {
    this.control = new BedrockAgentCoreClient({ region: options.region });
    this.host = `bedrock-agentcore.${options.region}.amazonaws.com`;
    this.signer = new SignatureV4({
      service: "bedrock-agentcore",
      region: options.region,
      sha256: Sha256,
      // Resolved from the ambient chain, so the deployed task uses its role and a laptop uses
      // AWS_PROFILE. Nothing here reads a key out of the repo's .env.
      credentials: this.control.config.credentials,
    });
  }

  /**
   * Starts a session and attaches the screencast. `channelId` is the MJPEG channel the frames are
   * published on — the scout uses the same string as its agent id so a tile's stream URL is
   * derivable from the event it already receives.
   */
  async start(channelId: string): Promise<BrowserSession> {
    const started = await this.control.send(
      new StartBrowserSessionCommand({
        browserIdentifier: this.options.browserIdentifier,
        sessionTimeoutSeconds: this.options.sessionTimeoutSeconds,
      }),
    );
    const sessionId = started.sessionId;
    if (!sessionId) throw new Error("AgentCore returned no sessionId.");

    let browser: Browser | undefined;
    try {
      browser = await chromium.connectOverCDP(await this.automationUrl(sessionId), {
        timeout: 60_000,
      });
      // The default context only. Creating a new one leaves the session's own context idle and the
      // screencast pointed at the wrong page.
      const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      await page.setViewportSize(this.options.viewport);

      const stopScreencast = await this.startScreencast(context, page, channelId);

      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await stopScreencast();
        this.options.frames.close(channelId);
        await browser?.close().catch(() => {});
        await this.control
          .send(
            new StopBrowserSessionCommand({
              browserIdentifier: this.options.browserIdentifier,
              sessionId,
            }),
          )
          .catch((error: unknown) => {
            // Losing the stop call leaks a session until its timeout, which costs money. Loud.
            console.error(`AgentCore session ${sessionId} failed to stop`, error);
          });
      };

      return { sessionId, page, close };
    } catch (error) {
      await browser?.close().catch(() => {});
      await this.control
        .send(
          new StopBrowserSessionCommand({
            browserIdentifier: this.options.browserIdentifier,
            sessionId,
          }),
        )
        .catch(() => {});
      throw error;
    }
  }

  private async startScreencast(
    context: BrowserContext,
    page: Page,
    channelId: string,
  ): Promise<() => Promise<void>> {
    const cdp = await context.newCDPSession(page);
    this.options.frames.open(channelId);

    cdp.on("Page.screencastFrame", (event) => {
      const frame = event as { data: string; sessionId: number };
      this.options.frames.push(channelId, Buffer.from(frame.data, "base64"));
      // Chrome stops sending frames until the previous one is acked.
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });

    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.options.jpegQuality,
      maxWidth: this.options.viewport.width,
      maxHeight: this.options.viewport.height,
      everyNthFrame: 1,
    });

    return async () => {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
    };
  }

  private async automationUrl(sessionId: string): Promise<string> {
    const path = `/browser-streams/${this.options.browserIdentifier}/sessions/${sessionId}/automation`;
    const presigned = await this.signer.presign(
      new HttpRequest({
        method: "GET",
        protocol: "https:",
        hostname: this.host,
        path,
        headers: { host: this.host },
      }),
      { expiresIn: 300 },
    );
    const query = new URLSearchParams(presigned.query as Record<string, string>).toString();
    return `wss://${this.host}${path}?${query}`;
  }
}
