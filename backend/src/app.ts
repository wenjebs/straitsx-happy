import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { Config } from "./config.js";
import { type ActivityEvent, DEFAULT_USER_ID, formatMinor, newId } from "./domain.js";
import { asMessage, HttpError } from "./errors.js";
import type { EventHub } from "./events.js";
import type { AgentProvider } from "./providers/agent.js";
import type { CardProvider } from "./providers/card.js";
import type { PurchaseAgentProvider } from "./providers/purchaseAgent.js";
import type { Repository } from "./repository.js";
import {
  AddWishlistItemBody,
  AgentCallbackEvent,
  ChooseOptionBody,
  CreateActivityBody,
  MandatePatch,
  PurchaseAgentCallbackEvent,
  PurchaseBody,
  SettingsPatch,
  TopUpBody,
} from "./schemas.js";
import type { ActivityService } from "./services/activities.js";
import type { PurchaseService } from "./services/purchases.js";

export interface AppDependencies {
  config: Config;
  repository: Repository;
  events: EventHub;
  agents: AgentProvider;
  cards: CardProvider;
  purchaseAgents: PurchaseAgentProvider;
  activities: ActivityService;
  purchases: PurchaseService;
}

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: deps.config.FRONTEND_ORIGIN,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", "x-happy-callback-token"],
      maxAge: 86_400,
    }),
  );

  app.get("/v1/health", (c) =>
    c.json({
      ok: true,
      dataStore: deps.config.DATA_STORE,
      agentProvider: deps.agents.mode,
      cardProvider: deps.cards.mode,
      purchaseAgentProvider: deps.purchaseAgents.mode,
      blockers: [
        ...(deps.agents.mode === "disabled" ? ["AGENT_API_NOT_CONFIGURED"] : []),
        ...(deps.cards.mode === "disabled" ? ["CARD_API_NOT_CONFIGURED"] : []),
        ...(deps.purchaseAgents.mode === "disabled" ? ["PURCHASE_AGENT_API_NOT_CONFIGURED"] : []),
      ],
      warnings: [
        ...(deps.agents.mode === "local" ? ["LOCAL_SCOUT_FAILSAFE"] : []),
        ...(deps.cards.mode === "local" ? ["LOCAL_CARD_FAILSAFE_NO_REAL_MONEY"] : []),
        ...(deps.purchaseAgents.mode === "local" ? ["LOCAL_CLOSER_FAILSAFE"] : []),
      ],
    }),
  );

  app.get("/v1/activities", async (c) => c.json(await deps.activities.list()));
  app.get("/v1/activities/:id", async (c) => c.json(await deps.activities.get(c.req.param("id"))));

  app.post("/v1/activities", async (c) => {
    const body = await parseBody(c.req.raw, CreateActivityBody);
    return c.json(await deps.activities.create(body.goal), 201);
  });

  app.post("/v1/activities/:id/wishlist/items", async (c) => {
    const body = await parseBody(c.req.raw, AddWishlistItemBody);
    return c.json(await deps.activities.addWishlistItem(c.req.param("id"), body.name));
  });

  app.delete("/v1/activities/:id/wishlist/items/:itemId", async (c) =>
    c.json(await deps.activities.removeWishlistItem(c.req.param("id"), c.req.param("itemId"))),
  );

  app.post("/v1/activities/:id/wishlist/approve", async (c) =>
    c.json(await deps.activities.approveWishlist(c.req.param("id"))),
  );

  app.post("/v1/activities/:id/clarifications/:itemId", async (c) => {
    const body = await parseBody(c.req.raw, ChooseOptionBody);
    return c.json(
      await deps.activities.chooseOption(c.req.param("id"), c.req.param("itemId"), body.option),
    );
  });

  app.post("/v1/activities/:id/dispatch", async (c) =>
    c.json(await deps.activities.dispatch(c.req.param("id"))),
  );
  app.post("/v1/activities/:id/search/pause", async (c) =>
    c.json(await deps.activities.setSearchPaused(c.req.param("id"), true)),
  );
  app.post("/v1/activities/:id/search/resume", async (c) =>
    c.json(await deps.activities.setSearchPaused(c.req.param("id"), false)),
  );
  app.post("/v1/activities/:id/shortlist/:itemId/reject", async (c) =>
    c.json(await deps.activities.rejectListing(c.req.param("id"), c.req.param("itemId"))),
  );

  app.post("/v1/activities/:id/purchase", async (c) => {
    const body = await parseBody(c.req.raw, PurchaseBody);
    return c.json(await deps.purchases.start(c.req.param("id"), body.idempotencyKey), 202);
  });

  app.get("/v1/activities/:id/events", async (c) => {
    const activityId = c.req.param("id");
    const initial = await deps.activities.get(activityId);
    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-cache, no-transform");

    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      let aborted = false;
      const writeEvent = (event: ActivityEvent) => {
        const { type, ...payload } = event;
        writes = writes.then(() => stream.writeSSE({ event: type, data: JSON.stringify(payload) }));
        return writes;
      };

      await writeEvent({ type: "activity.snapshot", activity: initial });
      const unsubscribe = deps.events.subscribe(activityId, writeEvent);
      stream.onAbort(() => {
        aborted = true;
        unsubscribe();
      });

      try {
        while (!aborted) {
          await stream.sleep(15_000);
          if (!aborted) {
            writes = writes.then(() => stream.write(": heartbeat\n\n").then(() => undefined));
            await writes;
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.post("/v1/integrations/agents/:id/events", async (c) => {
    assertCallbackAuth(c.req.header(), deps.config.AGENT_CALLBACK_TOKEN);
    const body = await parseBody(c.req.raw, AgentCallbackEvent);
    return c.json(await deps.activities.applyAgentEvent(c.req.param("id"), body), 202);
  });

  app.post("/v1/integrations/purchases/:id/events", async (c) => {
    assertCallbackAuth(c.req.header(), deps.config.PURCHASE_CALLBACK_TOKEN);
    const body = await parseBody(c.req.raw, PurchaseAgentCallbackEvent);
    return c.json(await deps.purchases.handleAgentEvent(c.req.param("id"), body), 202);
  });

  app.post("/v1/integrations/purchases/:id/attempts/:attemptId/card", async (c) => {
    const authorization = c.req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      throw new HttpError(401, "Card grant token is required.");
    }
    const card = await deps.purchases.claimCard(
      c.req.param("id"),
      c.req.param("attemptId"),
      authorization.slice("Bearer ".length),
    );
    return c.json(card, 201);
  });

  app.get("/v1/dev/streams/:id", (c) => {
    if (deps.agents.mode !== "local" && deps.purchaseAgents.mode !== "local") {
      throw new HttpError(404, "Local stream failsafe is disabled.");
    }
    const label = escapeHtml(c.req.query("label") ?? "agent browser");
    const kind = escapeHtml(c.req.query("kind") ?? "agent");
    return c.html(localStreamPage(label, kind));
  });

  app.get("/v1/dev/cards/:id", (c) => {
    if (deps.cards.mode !== "local") throw new HttpError(404, "Local card failsafe is disabled.");
    if (!c.req.header("authorization")?.startsWith("Bearer local-only-")) {
      throw new HttpError(401, "Local card capability is missing.");
    }
    return c.json({
      sandbox: true,
      warning: "LOCAL FAILSAFE — NOT A REAL CARD AND CANNOT SPEND MONEY",
      cardId: c.req.param("id"),
      pan: "4242424242424242",
      expiryMonth: "12",
      expiryYear: "40",
      cvc: "123",
    });
  });

  app.get("/v1/wallet", async (c) => c.json(await deps.repository.getWallet(DEFAULT_USER_ID)));
  app.post("/v1/wallet/topup", async (c) => {
    const body = await parseBody(c.req.raw, TopUpBody);
    if (deps.cards.mode === "disabled") {
      throw new HttpError(
        503,
        "Wallet top-up is unavailable until the card provider is configured.",
      );
    }
    if (deps.cards.mode === "local") {
      const settings = await deps.repository.getSettings(DEFAULT_USER_ID);
      if (!settings.sandbox) {
        throw new HttpError(409, "Local wallet top-up requires Sandbox mode.");
      }
    }
    const idempotencyKey = newId("topup");
    const result = await deps.cards.topUp({
      userId: DEFAULT_USER_ID,
      amountMinor: body.amountMinor,
      idempotencyKey,
    });
    const wallet = await deps.repository.getWallet(DEFAULT_USER_ID);
    wallet.balanceMinor += body.amountMinor;
    wallet.receipt = `+${formatMinor(body.amountMinor).replace("S$", "")} XSGD received · tx ${result.transactionId} · ${result.confirmations} confirmations`;
    wallet.transactions.unshift({
      id: newId("txn"),
      ts: "now",
      label: "XSGD wallet top-up",
      ref: result.transactionId,
      amount: `+${formatMinor(body.amountMinor)}`,
      debit: false,
    });
    await deps.repository.putWallet(DEFAULT_USER_ID, wallet);
    return c.json(wallet);
  });

  app.get("/v1/mandate", async (c) => c.json(await deps.repository.getMandate(DEFAULT_USER_ID)));
  app.patch("/v1/mandate", async (c) => {
    const patch = await parseBody(c.req.raw, MandatePatch);
    const current = await deps.repository.getMandate(DEFAULT_USER_ID);
    const mandate = {
      autoApprove: patch.autoApprove ?? current.autoApprove,
      itemCap: patch.itemCap ?? current.itemCap,
      actCap: patch.actCap ?? current.actCap,
      categoryRules: patch.categoryRules ?? current.categoryRules,
    };
    if (mandate.itemCap > mandate.actCap) {
      throw new HttpError(422, "Per-item cap cannot exceed the per-activity cap.");
    }
    await deps.repository.putMandate(DEFAULT_USER_ID, mandate);
    return c.json(mandate);
  });

  app.get("/v1/settings", async (c) => c.json(await deps.repository.getSettings(DEFAULT_USER_ID)));
  app.patch("/v1/settings", async (c) => {
    const patch = await parseBody(c.req.raw, SettingsPatch);
    const current = await deps.repository.getSettings(DEFAULT_USER_ID);
    const settings = {
      notify: patch.notify ?? current.notify,
      sandbox: patch.sandbox ?? current.sandbox,
      region: patch.region ?? current.region,
      dataRetention: patch.dataRetention ?? current.dataRetention,
    };
    await deps.repository.putSettings(DEFAULT_USER_ID, settings);
    return c.json(settings);
  });

  app.get("/v1/profile", async (c) => c.json(await deps.repository.getProfile(DEFAULT_USER_ID)));

  app.notFound((c) => c.text("Endpoint not found.", 404));
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.text(error.message, error.status as ContentfulStatusCode);
    }
    console.error(error);
    return c.text(`Backend error: ${asMessage(error)}`, 500);
  });

  return app;
}

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new HttpError(422, message);
  }
  return result.data;
}

function assertCallbackAuth(
  headers: Record<string, string>,
  expectedToken: string | undefined,
): void {
  if (!expectedToken) return;
  const authorization = headers.authorization;
  const actual = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : headers["x-happy-callback-token"];
  if (!actual || !safeEqual(actual, expectedToken)) {
    throw new HttpError(401, "Agent callback token is missing or invalid.");
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return escaped[char] ?? char;
  });
}

function localStreamPage(label: string, kind: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
    *{box-sizing:border-box}body{margin:0;background:#0b1020;color:#e8f0ff;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow:hidden}
    .bar{height:38px;background:#161d31;display:flex;align-items:center;gap:7px;padding:0 12px;border-bottom:1px solid #2b3655}.dot{width:9px;height:9px;border-radius:50%;background:#ff6b6b}.dot:nth-child(2){background:#ffd166}.dot:nth-child(3){background:#58d68d}.url{margin-left:8px;color:#91a3c8;font-size:11px}
    main{height:calc(100vh - 38px);display:grid;place-items:center;position:relative;background:radial-gradient(circle at 70% 20%,#233263 0,transparent 38%),#0b1020}.card{width:min(78%,480px);padding:25px;border:1px solid #35446c;border-radius:13px;background:#111a31;box-shadow:0 22px 70px #0008}.badge{display:inline-block;padding:5px 9px;background:#402348;color:#ffb3e6;border-radius:99px;font-size:10px;letter-spacing:.08em}.title{font:600 20px system-ui,sans-serif;margin:17px 0 8px}.muted{color:#9eb0d2;font-size:12px}.row{height:9px;border-radius:9px;background:#253354;margin-top:13px;overflow:hidden}.row:after{content:"";display:block;height:100%;width:38%;background:#7c9cff;animation:load 2.2s ease-in-out infinite}.row:nth-child(5):after{animation-delay:.5s;width:58%}.cursor{position:absolute;width:18px;height:24px;clip-path:polygon(0 0,0 100%,28% 72%,48% 100%,64% 92%,44% 65%,75% 65%);background:white;filter:drop-shadow(0 2px 2px #000);animation:move 4s ease-in-out infinite}@keyframes load{50%{transform:translateX(170%)}}@keyframes move{0%{transform:translate(-140px,70px)}50%{transform:translate(120px,-45px)}100%{transform:translate(-140px,70px)}}
  </style></head><body><div class="bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i><span class="url">local://${kind}/${label}</span></div><main><div class="card"><span class="badge">LOCAL FAILSAFE · NO REAL BROWSER OR PAYMENT</span><div class="title">${label}</div><div class="muted">Simulating ${kind} activity through the same callback and livestream contract.</div><div class="row"></div><div class="row"></div></div><div class="cursor"></div></main></body></html>`;
}
