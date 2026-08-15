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
import type { PaymentProvider } from "./providers/payment.js";
import type { Repository } from "./repository.js";
import {
  AddWishlistItemBody,
  AgentCallbackEvent,
  ChooseOptionBody,
  CreateActivityBody,
  MandatePatch,
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
  payments: PaymentProvider;
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
      paymentProvider: deps.payments.mode,
      blockers: [
        ...(deps.agents.mode === "disabled" ? ["AGENT_API_NOT_CONFIGURED"] : []),
        ...(deps.payments.mode === "disabled" ? ["PAYMENT_API_NOT_CONFIGURED"] : []),
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

  app.get("/v1/wallet", async (c) => c.json(await deps.repository.getWallet(DEFAULT_USER_ID)));
  app.post("/v1/wallet/topup", async (c) => {
    const body = await parseBody(c.req.raw, TopUpBody);
    if (deps.payments.mode === "disabled") {
      throw new HttpError(
        503,
        "Real wallet top-up is unavailable until PAYMENT_API_BASE_URL is configured.",
      );
    }
    const idempotencyKey = newId("topup");
    const result = await deps.payments.topUp({
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
