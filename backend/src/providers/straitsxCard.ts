import { randomBytes, timingSafeEqual } from "node:crypto";
import * as pay from "@happy/pay";
import type { CardProvider, IssueCardRequest, IssuedCard, TopUpResult } from "./card.js";
import { HttpError } from "../errors.js";

/**
 * The real rail. Wraps `@happy/pay`, which owns the mandate ledger, the x402 settlement and the
 * card mint. Card material stays inside the library — this provider hands the Closer a reveal
 * capability, never a PAN.
 */
export class StraitsXCardProvider implements CardProvider {
  readonly mode = "remote" as const;
  private readonly grants = new Map<string, string>();

  constructor(private readonly publicBaseUrl: string) {}

  async issueCard(request: IssueCardRequest): Promise<IssuedCard> {
    const amountCents = request.listing.amountMinor;
    const merchantHost = hostOf(request.listing.url ?? "");
    await this.ensureMandate(merchantHost, amountCents, request.mandate.actCap * 100);

    const purchase = await pay.reserve({
      amountCents,
      merchantHost,
      itemName: request.item.name,
      ...(request.listing.url ? { productUrl: request.listing.url } : {}),
    });
    await pay.approve(purchase.id);

    let card: { last4: string | null; expiresAt: string | number | null };
    try {
      card = await pay.issueCard(purchase.id, amountCents);
    } catch (error) {
      await pay.cancel(purchase.id, "issue_failed").catch(() => {});
      throw new HttpError(502, error instanceof Error ? error.message : "Card issuance failed.");
    }

    const token = randomBytes(32).toString("base64url");
    this.grants.set(purchase.id, token);
    return {
      cardId: purchase.id,
      last4: card.last4 ?? "0000",
      agentAccess: {
        revealUrl: `${this.publicBaseUrl.replace(/\/$/, "")}/v1/cards/${encodeURIComponent(purchase.id)}/reveal`,
        token,
        ...(card.expiresAt ? { expiresAt: new Date(card.expiresAt).toISOString() } : {}),
      },
    };
  }

  /**
   * One-use: the grant is consumed by the first reveal that presents it, so a leaked URL replayed
   * later gets nothing. Compared in constant time — the token guards live card material.
   */
  consumeGrant(cardId: string, token: string): boolean {
    const expected = this.grants.get(cardId);
    if (!expected) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    this.grants.delete(cardId);
    return true;
  }

  async topUp(): Promise<TopUpResult> {
    throw new HttpError(501, "Top-ups run on the wallet funding path, not the card rail.");
  }

  private async ensureMandate(host: string, amountCents: number, dailyCapMinor: number) {
    const current = await pay.getMandate();
    const merchants = new Set((current?.merchants ?? []).map((m) => m.toLowerCase()));
    const live =
      current &&
      current.status === "ACTIVE" &&
      new Date(current.expiresAt).getTime() > Date.now() &&
      merchants.has(host);
    if (live) return;
    merchants.add(host);
    await pay.createMandate({
      perItemCents: Math.max(amountCents, current?.perItemCents ?? 0),
      dailyCents: Math.max(dailyCapMinor, current?.dailyCents ?? 0, amountCents),
      merchants: [...merchants],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "unknown.local";
  }
}
