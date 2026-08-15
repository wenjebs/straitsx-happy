import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chromium } from "playwright";
import { startAgentCoreSession } from "../agentcore.js";
import type { BrowserLike } from "../types.js";
import { createJobStore, type JobStore } from "./jobs.js";
import { createLiveView, type LiveView } from "./liveview.js";
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
      if (parts[3] === "stream") return view.attach(attemptId, res);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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

/** AgentCore for a real merchant; a local Chromium for anything on this machine. */
export async function browserForEnv(): Promise<BrowserLike> {
  if ((process.env.CLOSER_BROWSER ?? "local") === "agentcore") {
    return startAgentCoreSession({
      profile: process.env.AWS_PROFILE ?? "happy",
      region: process.env.AWS_REGION ?? "ap-southeast-1",
      name: "happy-purchase-run",
    });
  }
  const browser = await chromium.launch();
  const context = await browser.newContext();
  return { newPage: () => context.newPage() };
}
