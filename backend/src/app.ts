import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { Config } from "./config.js";
import type { ActivityEvent, Profile } from "./domain.js";
import { asMessage, HttpError } from "./errors.js";
import type { EventHub } from "./events.js";
import type { PlannerProvider, ScoutProvider } from "./providers/agent.js";
import type { CardProvider } from "./providers/card.js";
import type { PurchaseAgentProvider } from "./providers/purchaseAgent.js";
import type { Repository } from "./repository.js";
import {
  AddWishlistItemBody,
  AgentCallbackEvent,
  ChooseOptionBody,
  ConfirmSignupBody,
  CreateActivityBody,
  LoginBody,
  MandatePatch,
  PurchaseAgentCallbackEvent,
  PurchaseBody,
  RefreshSessionBody,
  SettingsPatch,
  SignupBody,
  WalletAuthChallengeBody,
  WalletAuthVerifyBody,
  WalletDepositBody,
} from "./schemas.js";
import type { ActivityService } from "./services/activities.js";
import type { AuthService, AuthUser } from "./services/auth.js";
import type { PurchaseService } from "./services/purchases.js";
import type { WalletAuthService } from "./services/walletAuth.js";
import type { WalletFundingService } from "./services/walletFunding.js";

export interface AppDependencies {
  config: Config;
  repository: Repository;
  events: EventHub;
  planner: PlannerProvider;
  scouts: ScoutProvider;
  cards: CardProvider;
  purchaseAgents: PurchaseAgentProvider;
  activities: ActivityService;
  purchases: PurchaseService;
  funding: WalletFundingService;
  walletAuth: WalletAuthService;
  auth: AuthService;
}

type AppBindings = { Variables: { user: AuthUser } };

export function createApp(deps: AppDependencies): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use(
    "*",
    cors({
      origin: deps.config.FRONTEND_ORIGIN,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "content-type",
        "authorization",
        "x-happy-callback-token",
        "x-happy-wallet-session",
      ],
      maxAge: 86_400,
    }),
  );

  app.get("/v1/health", (c) =>
    c.json({
      ok: true,
      dataStore: deps.config.DATA_STORE,
      plannerProvider: deps.planner.mode,
      scoutProvider: deps.scouts.mode,
      cardProvider: deps.cards.mode,
      purchaseAgentProvider: deps.purchaseAgents.mode,
      fundingProvider: deps.config.FUNDING_MODE,
      authProvider: deps.auth.mode,
      blockers: [
        ...(deps.planner.mode === "disabled" ? ["PLANNER_NOT_CONFIGURED"] : []),
        ...(deps.scouts.mode === "disabled" ? ["SCOUT_API_NOT_CONFIGURED"] : []),
        ...(deps.cards.mode === "disabled" ? ["CARD_API_NOT_CONFIGURED"] : []),
        ...(deps.purchaseAgents.mode === "disabled" ? ["PURCHASE_AGENT_API_NOT_CONFIGURED"] : []),
        ...(deps.config.FUNDING_MODE === "disabled" ? ["XSGD_FUNDING_NOT_CONFIGURED"] : []),
      ],
      warnings: [
        ...(deps.planner.mode === "local" ? ["LOCAL_PLANNER_FAILSAFE"] : []),
        ...(deps.scouts.mode === "local" ? ["LOCAL_SCOUT_FAILSAFE"] : []),
        ...(deps.cards.mode === "local" ? ["LOCAL_CARD_FAILSAFE_NO_REAL_MONEY"] : []),
        ...(deps.purchaseAgents.mode === "local" ? ["LOCAL_CLOSER_FAILSAFE"] : []),
      ],
    }),
  );

  app.post("/v1/auth/signup", async (c) => {
    const body = await parseBody(c.req.raw, SignupBody);
    return c.json(await deps.auth.signup(body.name, body.email, body.password), 201);
  });
  app.post("/v1/auth/confirm", async (c) => {
    const body = await parseBody(c.req.raw, ConfirmSignupBody);
    await deps.auth.confirmSignup(body.email, body.code);
    return c.body(null, 204);
  });
  app.post("/v1/auth/login", async (c) => {
    const body = await parseBody(c.req.raw, LoginBody);
    return c.json(await deps.auth.login(body.email, body.password));
  });
  app.post("/v1/auth/refresh", async (c) => {
    const body = await parseBody(c.req.raw, RefreshSessionBody);
    return c.json(await deps.auth.refresh(body.refreshToken));
  });

  app.use("/v1/*", async (c, next) => {
    if (c.req.path.startsWith("/v1/integrations/") || c.req.path.startsWith("/v1/dev/")) {
      await next();
      return;
    }
    c.set("user", await deps.auth.authenticate(c.req.header("authorization")));
    await next();
  });

  app.get("/v1/auth/me", (c) => c.json(c.get("user")));
  app.post("/v1/auth/logout", (c) => c.body(null, 204));

  const assertOwnedActivity: MiddlewareHandler<AppBindings> = async (c, next) => {
    const id = c.req.param("id");
    if (!id) throw new HttpError(404, "Activity not found.");
    const activity = await deps.repository.getActivity(id);
    const user = c.get("user");
    if (!activity || activity.userId !== user.id) throw new HttpError(404, "Activity not found.");
    await next();
  };
  app.use("/v1/activities/:id", assertOwnedActivity);
  app.use("/v1/activities/:id/*", assertOwnedActivity);

  app.get("/v1/activities", async (c) => c.json(await deps.activities.list(c.get("user").id)));
  app.get("/v1/activities/:id", async (c) => c.json(await deps.activities.get(c.req.param("id"))));
  app.get("/v1/activities/:id/checkpoints", async (c) =>
    c.json(await deps.activities.history(c.req.param("id"))),
  );

  app.post("/v1/activities", async (c) => {
    const body = await parseBody(c.req.raw, CreateActivityBody);
    return c.json(await deps.activities.create(body.goal, c.get("user").id), 201);
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

  app.post("/v1/activities/:id/wishlist/reopen", async (c) =>
    c.json(await deps.activities.reopenWishlist(c.req.param("id"))),
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

  app.post("/v1/activities/:id/cancel", async (c) => {
    const activity = await deps.activities.get(c.req.param("id"));
    return c.json(
      activity.stage === "exec"
        ? await deps.purchases.cancel(activity.id)
        : await deps.activities.cancel(activity.id),
    );
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
    if (deps.scouts.mode !== "local" && deps.purchaseAgents.mode !== "local") {
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

  app.post("/v1/wallet/auth/challenge", async (c) => {
    const body = await parseBody(c.req.raw, WalletAuthChallengeBody);
    return c.json(deps.walletAuth.challenge(c.get("user").id, body.address), 201);
  });
  app.post("/v1/wallet/auth/verify", async (c) => {
    const body = await parseBody(c.req.raw, WalletAuthVerifyBody);
    return c.json(
      await deps.walletAuth.verify(c.get("user").id, body.challengeToken, body.signature),
      201,
    );
  });
  app.get("/v1/wallet", async (c) => {
    return c.json(await deps.funding.wallet(c.get("user").id));
  });
  app.get("/v1/wallet/funding", async (c) => {
    return c.json(await deps.funding.snapshot(c.get("user").id));
  });
  app.post("/v1/wallet/deposits", async (c) => {
    const identity = deps.walletAuth.identity(c.req.header("x-happy-wallet-session"), true);
    if (!identity) throw new HttpError(401, "Connect and authorize your wallet first.");
    if (identity.userId !== c.get("user").id) {
      throw new HttpError(403, "This wallet is authorized for a different Happy account.");
    }
    const body = await parseBody(c.req.raw, WalletDepositBody);
    if (body.sourceAddress.toLowerCase() !== identity.address) {
      throw new HttpError(403, "The deposit source must match the authorized wallet.");
    }
    const result = await deps.funding.submit(identity.userId, body.txHash, body.sourceAddress);
    return c.json(result, result.deposit.status === "confirmed" ? 201 : 202);
  });
  app.get("/v1/wallet/deposits/:txHash", async (c) => {
    const identity = deps.walletAuth.identity(c.req.header("x-happy-wallet-session"), true);
    if (!identity) throw new HttpError(401, "Connect and authorize your wallet first.");
    if (identity.userId !== c.get("user").id) {
      throw new HttpError(403, "This wallet is authorized for a different Happy account.");
    }
    return c.json(await deps.funding.refresh(identity.userId, c.req.param("txHash")));
  });
  app.post("/v1/wallet/topup", () => {
    throw new HttpError(
      410,
      "Synthetic top-ups were removed. Transfer XSGD and register it with /v1/wallet/deposits.",
    );
  });

  app.get("/v1/mandate", async (c) => c.json(await deps.repository.getMandate(c.get("user").id)));
  app.patch("/v1/mandate", async (c) => {
    const patch = await parseBody(c.req.raw, MandatePatch);
    const userId = c.get("user").id;
    const current = await deps.repository.getMandate(userId);
    const mandate = {
      autoApprove: patch.autoApprove ?? current.autoApprove,
      itemCap: patch.itemCap ?? current.itemCap,
      actCap: patch.actCap ?? current.actCap,
      categoryRules: patch.categoryRules ?? current.categoryRules,
    };
    if (mandate.itemCap > mandate.actCap) {
      throw new HttpError(422, "Per-item cap cannot exceed the per-activity cap.");
    }
    await deps.repository.putMandate(userId, mandate);
    return c.json(mandate);
  });

  app.get("/v1/settings", async (c) => c.json(await deps.repository.getSettings(c.get("user").id)));
  app.patch("/v1/settings", async (c) => {
    const patch = await parseBody(c.req.raw, SettingsPatch);
    const userId = c.get("user").id;
    const current = await deps.repository.getSettings(userId);
    const settings = {
      notify: patch.notify ?? current.notify,
      sandbox: patch.sandbox ?? current.sandbox,
      region: patch.region ?? current.region,
      dataRetention: patch.dataRetention ?? current.dataRetention,
    };
    await deps.repository.putSettings(userId, settings);
    return c.json(settings);
  });

  app.get("/v1/profile", (c) => c.json(profileForUser(c.get("user"))));

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

function profileForUser(user: AuthUser): Profile {
  const joined = new Intl.DateTimeFormat("en-SG", {
    month: "short",
    year: "numeric",
    timeZone: "Asia/Singapore",
  }).format(new Date(user.createdAt));
  return {
    name: user.name,
    email: user.email,
    initials: user.initials,
    memberSince: `Account active · ${joined}`,
    rows: [
      { k: "Email", v: user.email },
      { k: "Account security", v: "Email and password" },
      { k: "Funding wallet", v: "Connected separately" },
    ],
  };
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
