import { z } from "zod";
import type { Activity, Listing, Mandate, WishlistItem } from "../domain.js";
import { HttpError } from "../errors.js";

export interface IssueCardRequest {
  activity: Activity;
  item: WishlistItem;
  listing: Listing;
  mandate: Mandate;
  idempotencyKey: string;
}

export interface IssuedCard {
  cardId: string;
  last4: string;
  /** One-use capability passed only to the trusted Closer agent. */
  agentAccess: {
    revealUrl: string;
    token: string;
    expiresAt?: string | undefined;
  };
}

export interface TopUpResult {
  transactionId: string;
  confirmations: number;
}

export interface CardProvider {
  readonly mode: "local" | "remote" | "disabled";
  issueCard(request: IssueCardRequest): Promise<IssuedCard>;
  topUp(request: {
    userId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<TopUpResult>;
}

const IssuedCardResponse = z.object({
  cardId: z.string().min(1),
  last4: z.string().regex(/^\d{4}$/),
  agentAccess: z.object({
    revealUrl: z.url(),
    token: z.string().min(1),
    expiresAt: z.iso.datetime().optional(),
  }),
});
const TopUpResponse = z.object({
  transactionId: z.string().min(1),
  confirmations: z.number().int().nonnegative(),
});

export interface RemoteCardOptions {
  baseUrl: string;
  token?: string;
}

/** StraitsX adapter. Card details remain behind a short-lived agent capability. */
export class RemoteCardProvider implements CardProvider {
  readonly mode = "remote" as const;

  constructor(private readonly options: RemoteCardOptions) {}

  async issueCard(request: IssueCardRequest): Promise<IssuedCard> {
    const data = await this.post("/v1/cards", {
      activityId: request.activity.id,
      itemId: request.item.id,
      amountMinor: request.listing.amountMinor,
      currency: "SGD",
      merchant: request.listing.seller,
      sandbox: false,
      idempotencyKey: request.idempotencyKey,
      mandate: request.mandate,
    });
    return IssuedCardResponse.parse(data);
  }

  async topUp(request: {
    userId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<TopUpResult> {
    const data = await this.post("/v1/wallet/topups", { ...request, currency: "XSGD" });
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
        `Card service rejected the request (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return response.json();
  }
}

/** Explicitly fake card rail for the local website walkthrough. */
export class LocalCardProvider implements CardProvider {
  readonly mode = "local" as const;
  private readonly issued = new Map<string, IssuedCard>();

  constructor(private readonly publicBaseUrl: string) {}

  async issueCard(request: IssueCardRequest): Promise<IssuedCard> {
    const existing = this.issued.get(request.idempotencyKey);
    if (existing) return structuredClone(existing);
    const cardId = `local-card-${crypto.randomUUID()}`;
    const last4 = String(1000 + Math.floor(Math.random() * 9000));
    const card: IssuedCard = {
      cardId,
      last4,
      agentAccess: {
        revealUrl: `${this.publicBaseUrl.replace(/\/$/, "")}/v1/dev/cards/${encodeURIComponent(cardId)}`,
        token: `local-only-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
    this.issued.set(request.idempotencyKey, card);
    return structuredClone(card);
  }

  async topUp(): Promise<TopUpResult> {
    return {
      transactionId: `local-${crypto.randomUUID().slice(0, 12)}`,
      confirmations: 1,
    };
  }
}

export class DisabledCardProvider implements CardProvider {
  readonly mode = "disabled" as const;

  private unavailable(): never {
    throw new HttpError(
      503,
      "StraitsX card service is not configured. Set CARD_MODE=remote and CARD_API_BASE_URL.",
    );
  }

  async issueCard(): Promise<IssuedCard> {
    return this.unavailable();
  }

  async topUp(): Promise<TopUpResult> {
    return this.unavailable();
  }
}
