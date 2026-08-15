import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chromium } from "playwright";
import { startAgentCoreSession } from "../agentcore.js";
import type { BrowserLike } from "../types.js";
import { createJobStore, type JobStore } from "./jobs.js";
import { createLiveView, isValidAttemptId, type LiveView } from "./liveview.js";
import type { PurchaseJobInput } from "./verify.js";

/**
 * The two endpoints Happy already knows how to call, plus the live view they reference.
 *
 * node:http rather than a framework: this is four routes, and nothing else in packages/closer has
 * an HTTP dependency worth adding one for.
 */
export function createPurchaseServer(opts: {
  token: string;
  jobs?: JobStore;
  view?: LiveView;
  startRun: (job: PurchaseJobInput) => void;
}): Server {
  const jobs = opts.jobs ?? createJobStore();
  const view = opts.view ?? createLiveView();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    // The live view is opened by a browser inside an iframe and cannot carry a bearer token, so it
    // sits outside the authenticated surface. It shows pixels of a page the operator already
    // approved, and is blanked across card entry.
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "live") {
      const attemptId = decodeURIComponent(parts[2] ?? "");
      // Rejected rather than escaped-and-served: this route is unauthenticated and its page is
      // what blanks during card entry, so script running in that origin could re-enable frame
      // rendering and read the card off the canvas.
      if (!isValidAttemptId(attemptId)) return send(res, 400, { error: "bad attempt id" });
      if (parts[3] === "stream") return view.attach(attemptId, res);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        // The page needs only its own inline script and the data: URIs it builds from frames.
        "content-security-policy":
          "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        "x-content-type-options": "nosniff",
      });
      return res.end(view.page(attemptId));
    }

    if (req.method !== "POST") return send(res, 404, { error: "not found" });

    if (req.headers.authorization !== `Bearer ${opts.token}`) {
      return send(res, 401, { error: "unauthorized" });
    }

    const body = await readJson(req);

    if (parts[0] === "v1" && parts[1] === "purchase-runs" && parts.length === 2) {
      const job = body as PurchaseJobInput;
      if (
        !job?.activityId ||
        !job.attemptId ||
        !job.idempotencyKey ||
        !job.item?.id ||
        !job.listing ||
        !job.cardGrant ||
        !job.callback?.url
      ) {
        return send(res, 400, { error: "malformed purchase job" });
      }
      const { created } = jobs.accept(job);
      // Answered before anything slow starts: Happy times out at 15 seconds and treats a late
      // reply as a 502, which would strand a run we were about to begin.
      send(res, 202, { accepted: true, duplicate: !created });
      if (created) opts.startRun(job);
      return;
    }

    if (parts[0] === "v1" && parts[1] === "purchase-runs" && parts[3] === "cancel") {
      const activityId = decodeURIComponent(parts[2] ?? "");
      const attemptId = (body as { attemptId?: string })?.attemptId;
      jobs.cancel(activityId, attemptId);
      // 200 even for an unknown attempt: cancelling something already finished is not an error.
      return send(res, 200, { cancelled: true });
    }

    return send(res, 404, { error: "not found" });
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * Every browser handed out and not yet released.
 *
 * Tracked so a Ctrl-C can close them. A run releases its own browser when it ends, but a process
 * killed mid-run never gets there, and an AgentCore session bills until it is stopped.
 */
const live = new Set<BrowserLike>();

/** Closes every browser still open. Returns how many. */
export async function stopAllBrowsers(): Promise<number> {
  const all = [...live];
  live.clear();
  await Promise.allSettled(all.map((b) => releaseBrowser(b)));
  return all.length;
}

/** AgentCore for a real merchant; a local Chromium for anything on this machine. */
export async function browserForEnv(): Promise<BrowserLike> {
  if ((process.env.CLOSER_BROWSER ?? "local") === "agentcore") {
    const session = await startAgentCoreSession({
      // On ECS there is no ini file: the task role must come from the ambient chain. A named
      // profile is only for laptops, whose `default` is a Scaleway one.
      ...(process.env.AWS_PROFILE ? { profile: process.env.AWS_PROFILE } : {}),
      region: process.env.AWS_REGION ?? "ap-southeast-1",
      name: "happy-purchase-run",
    });
    live.add(session);
    return session;
  }
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const like: BrowserLike & { close: () => Promise<void> } = {
    newPage: () => context.newPage(),
    close: () => browser.close(),
  };
  live.add(like);
  return like;
}

/**
 * Ends the browser session, whatever kind it is.
 *
 * `BrowserLike` is only `{ newPage }` because that is all the runner needs, but both concrete
 * implementations carry a `close`. Skipping this leaves an AgentCore session billing for its full
 * half-hour TTL — three failed runs left three sessions running before it was caught.
 */
export async function releaseBrowser(browser: BrowserLike): Promise<void> {
  live.delete(browser);
  const closable = browser as BrowserLike & { close?: () => Promise<void> };
  if (typeof closable.close === "function") await closable.close();
}
