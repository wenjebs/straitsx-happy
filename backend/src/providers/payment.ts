import { z } from "zod";
import type { Activity, Listing, Mandate, Settings, WishlistItem } from "../domain.js";
import { HttpError } from "../errors.js";

export interface IssueCardRequest {
  activity: Activity;
  item: WishlistItem;
  listing: Listing;
  mandate: Mandate;
  settings: Settings;
  idempotencyKey: string;
}

export interface IssuedCard {
  cardId: string;
  last4: string;
}

export interface PreparedCheckout {
  checkoutId: string;
  merchant: string;
}

export interface PlacedOrder {
  orderId: string;
}

export interface TopUpResult {
  transactionId: string;
  confirmations: number;
}

export interface PaymentProvider {
  readonly mode: "remote" | "disabled";
  issueCard(request: IssueCardRequest): Promise<IssuedCard>;
  prepareCheckout(request: IssueCardRequest & { card: IssuedCard }): Promise<PreparedCheckout>;
  placeOrder(
    request: IssueCardRequest & { card: IssuedCard; checkout: PreparedCheckout },
  ): Promise<PlacedOrder>;
  topUp(request: {
    userId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<TopUpResult>;
}

const IssuedCardResponse = z.object({
  cardId: z.string().min(1),
  last4: z.string().regex(/^\d{4}$/),
});
const PreparedCheckoutResponse = z.object({
  checkoutId: z.string().min(1),
  merchant: z.string().min(1),
});
const PlacedOrderResponse = z.object({ orderId: z.string().min(1) });
const TopUpResponse = z.object({
  transactionId: z.string().min(1),
  confirmations: z.number().int().nonnegative(),
});

export interface RemotePaymentOptions {
  baseUrl: string;
  token?: string;
}

/**
 * Happy never receives or stores a full PAN. The payment/closer service owns
 * card reveal and merchant autofill, while Happy owns mandate decisions and
 * exact-value/idempotency inputs.
 */
export class RemotePaymentProvider implements PaymentProvider {
  readonly mode = "remote" as const;

  constructor(private readonly options: RemotePaymentOptions) {}

  async issueCard(request: IssueCardRequest): Promise<IssuedCard> {
    const data = await this.post("/v1/cards", {
      activityId: request.activity.id,
      itemId: request.item.id,
      amountMinor: request.listing.amountMinor,
      currency: "SGD",
      merchant: request.listing.seller,
      sandbox: request.settings.sandbox,
      idempotencyKey: `${request.idempotencyKey}:card`,
      mandate: request.mandate,
    });
    return IssuedCardResponse.parse(data);
  }

  async prepareCheckout(
    request: IssueCardRequest & { card: IssuedCard },
  ): Promise<PreparedCheckout> {
    const data = await this.post("/v1/checkouts", {
      activityId: request.activity.id,
      itemId: request.item.id,
      listing: request.listing,
      cardId: request.card.cardId,
      sandbox: request.settings.sandbox,
      idempotencyKey: `${request.idempotencyKey}:prepare`,
    });
    return PreparedCheckoutResponse.parse(data);
  }

  async placeOrder(
    request: IssueCardRequest & { card: IssuedCard; checkout: PreparedCheckout },
  ): Promise<PlacedOrder> {
    const data = await this.post(
      `/v1/checkouts/${encodeURIComponent(request.checkout.checkoutId)}/place`,
      {
        activityId: request.activity.id,
        itemId: request.item.id,
        amountMinor: request.listing.amountMinor,
        idempotencyKey: `${request.idempotencyKey}:place`,
      },
    );
    return PlacedOrderResponse.parse(data);
  }

  async topUp(request: {
    userId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<TopUpResult> {
    const data = await this.post("/v1/wallet/topups", {
      ...request,
      currency: "XSGD",
    });
    return TopUpResponse.parse(data);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new HttpError(
        502,
        `Payment service rejected the request (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return response.json();
  }
}

export class DisabledPaymentProvider implements PaymentProvider {
  readonly mode = "disabled" as const;

  private unavailable(): never {
    throw new HttpError(
      503,
      "Real payment service is not configured. Set PAYMENT_API_BASE_URL and its API credentials.",
    );
  }

  async issueCard(): Promise<IssuedCard> {
    return this.unavailable();
  }

  async prepareCheckout(): Promise<PreparedCheckout> {
    return this.unavailable();
  }

  async placeOrder(): Promise<PlacedOrder> {
    return this.unavailable();
  }

  async topUp(): Promise<TopUpResult> {
    return this.unavailable();
  }
}
