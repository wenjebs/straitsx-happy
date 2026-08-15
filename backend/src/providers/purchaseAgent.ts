import type { Listing, WishlistItem } from "../domain.js";
import { HttpError } from "../errors.js";

export interface CardGrant {
  claimUrl: string;
  token: string;
  amountMinor: number;
  currency: "SGD";
  expiresAt: string;
}

export interface PurchaseAgentRequest {
  activityId: string;
  attemptId: string;
  item: WishlistItem;
  listing: Listing;
  cardGrant: CardGrant;
  sandbox: boolean;
  idempotencyKey: string;
}

export interface PurchaseAgentProvider {
  readonly mode: "local" | "remote" | "disabled";
  startPurchase(request: PurchaseAgentRequest): Promise<void>;
}

interface CallbackOptions {
  callbackBaseUrl: string;
  callbackToken?: string;
}

export interface RemotePurchaseAgentOptions extends CallbackOptions {
  baseUrl: string;
  token?: string;
}

/** Dispatches a listing and one-use card grant to the separately-owned Closer agent. */
export class RemotePurchaseAgentProvider implements PurchaseAgentProvider {
  readonly mode = "remote" as const;

  constructor(private readonly options: RemotePurchaseAgentOptions) {}

  async startPurchase(request: PurchaseAgentRequest): Promise<void> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/v1/purchase-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      body: JSON.stringify({
        ...request,
        amountMinor: request.listing.amountMinor,
        callback: callbackFor(this.options, request.activityId),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new HttpError(
        502,
        `Purchase agent rejected the job (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
  }
}

/** Local asynchronous Closer that drives the real callback/SSE path without spending. */
export class LocalPurchaseAgentProvider implements PurchaseAgentProvider {
  readonly mode = "local" as const;

  constructor(private readonly options: CallbackOptions) {}

  async startPurchase(request: PurchaseAgentRequest): Promise<void> {
    if (!request.sandbox) {
      throw new HttpError(409, "Local Closer failsafe only runs in Sandbox mode.");
    }
    void this.run(request).catch(async (error) => {
      await postCallback(callbackFor(this.options, request.activityId), {
        eventId: crypto.randomUUID(),
        attemptId: request.attemptId,
        itemId: request.item.id,
        type: "purchase.failed",
        message: error instanceof Error ? error.message : "Local Closer failed.",
        retryable: true,
      });
    });
  }

  private async run(request: PurchaseAgentRequest): Promise<void> {
    const callback = callbackFor(this.options, request.activityId);
    const stream = `${this.options.callbackBaseUrl.replace(/\/$/, "")}/v1/dev/streams/${encodeURIComponent(`closer-${request.attemptId}`)}?kind=closer&label=${encodeURIComponent(request.item.name)}`;
    const common = {
      attemptId: request.attemptId,
      itemId: request.item.id,
    };

    await delay(350);
    await claimCard(request.cardGrant);
    await delay(650);
    await postCallback(callback, {
      ...common,
      eventId: crypto.randomUUID(),
      type: "browser.started",
      liveStreamUrl: stream,
      message: `opened ${request.listing.url ?? request.listing.title}`,
    });
    await delay(750);
    await postCallback(callback, {
      ...common,
      eventId: crypto.randomUUID(),
      type: "checkout.prepared",
      message: `${request.listing.seller}/checkout · local autofill ok`,
    });
    await delay(750);
    await postCallback(callback, {
      ...common,
      eventId: crypto.randomUUID(),
      type: "order.placing",
      message: `placing sandbox order ${request.listing.price}`,
    });
    await delay(850);
    await postCallback(callback, {
      ...common,
      eventId: crypto.randomUUID(),
      type: "order.confirmed",
      orderId: `LOCAL-${Math.floor(100000 + Math.random() * 900000)}`,
      message: "sandbox merchant confirmed the order",
    });
  }
}

async function claimCard(grant: CardGrant): Promise<void> {
  const response = await fetch(grant.claimUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${grant.token}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Local Closer could not claim its card (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  await response.json();
}

export class DisabledPurchaseAgentProvider implements PurchaseAgentProvider {
  readonly mode = "disabled" as const;

  async startPurchase(): Promise<void> {
    throw new HttpError(
      503,
      "Closer agent is not configured. Set PURCHASE_AGENT_MODE=remote and PURCHASE_AGENT_API_BASE_URL.",
    );
  }
}

function callbackFor(options: CallbackOptions, activityId: string) {
  return {
    url: `${options.callbackBaseUrl.replace(/\/$/, "")}/v1/integrations/purchases/${encodeURIComponent(activityId)}/events`,
    ...(options.callbackToken ? { token: options.callbackToken } : {}),
  };
}

async function postCallback(
  callback: { url: string; token?: string },
  body: unknown,
): Promise<void> {
  const response = await fetch(callback.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(callback.token ? { authorization: `Bearer ${callback.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Local purchase callback failed: ${response.status}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
