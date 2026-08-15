import { minorToAmountSgd } from "@happy/shared";
import type { Config } from "../config.js";
import type { TokenBucket } from "../x402/bucket.js";
import {
  buildAuthorization,
  buildEnvelope,
  eip712,
  newNonce,
  parseChallenge,
  validateChallenge,
  X402Error,
} from "../x402/client.js";
import {
  assertIssuable,
  type CardMaterial,
  type IssueRequest,
  type IssueResult,
  type IssuerAdapter,
  type PreparedPayment,
} from "./types.js";

type Fetch = typeof fetch;
type Account = { address: string; signTypedData(args: any): Promise<string> };

export class StraitsXIssuer implements IssuerAdapter {
  readonly name = "straitsx" as const;
  private material = new Map<string, CardMaterial>();

  constructor(
    private readonly cfg: Config,
    private readonly account: Account,
    private readonly bucket: TokenBucket,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private url() {
    return `${this.cfg.cardApiBase}/issue_card`;
  }

  private body(req: IssueRequest) {
    return JSON.stringify({
      // minorToAmountSgd is bigint-in, STRING-out ("18.50"); the rail wants a JSON number.
      amount_sgd: Number(minorToAmountSgd(BigInt(req.amountCents))), // fractional accepted, verified live
      cardholder_name: req.cardholderName,
      wallet_address: this.account.address,
    });
  }

  private async post(body: string, envelope?: string) {
    if (!this.bucket.take()) throw new X402Error("RATE_LIMITED", "local rail budget exhausted");
    const res = await this.fetchImpl(this.url(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(envelope ? { "PAYMENT-SIGNATURE": envelope } : {}),
      },
      body,
    });
    const text = await res.text(); // 400/429 bodies are plain text
    if (res.status === 429) throw new X402Error("RATE_LIMITED", text.slice(0, 200));
    return { res, text };
  }

  /** Probe, validate, sign. Spends nothing. The caller persists the result before send(). */
  async prepare(req: IssueRequest): Promise<PreparedPayment> {
    assertIssuable(
      req.amountCents,
      req.cardholderName,
      this.cfg.minCardCents,
      this.cfg.maxCardCents,
    );

    const probe = await this.post(this.body(req));
    if (probe.res.status !== 402) {
      throw new X402Error(
        "UNAVAILABLE",
        `expected 402, got ${probe.res.status}: ${probe.text.slice(0, 200)}`,
      );
    }
    const entry = parseChallenge(probe.res, probe.text);
    validateChallenge(entry, this.cfg, req.amountCents);

    const nonce = newNonce();
    const authorization = buildAuthorization(entry, this.account.address, nonce);
    const signature = await this.account.signTypedData(eip712(entry, authorization));

    return {
      nonce,
      envelope: buildEnvelope(entry, signature, authorization),
      validBeforeMs: Number(authorization.validBefore) * 1000,
    };
  }

  /**
   * Irreversible. Replaying the same prepared payment is safe and is how a lost response is
   * recovered: the nonce is consumed on-chain, so a duplicate can never settle twice.
   */
  async send(req: IssueRequest, prepared: PreparedPayment): Promise<IssueResult> {
    const paid = await this.post(this.body(req), prepared.envelope);
    if (!paid.res.ok)
      throw new X402Error("REJECTED", `${paid.res.status}: ${paid.text.slice(0, 300)}`);

    const card = JSON.parse(paid.text) as {
      card_opaque_id: string;
      settlement_tx: string | null;
      card_html?: string;
    };
    if (card.card_html) this.captureMaterial(card.card_opaque_id, card.card_html);

    return {
      opaqueId: card.card_opaque_id,
      last4: this.material.get(card.card_opaque_id)?.pan.slice(-4) ?? null,
      expiresAt: null,
      settlementTx: card.settlement_tx ?? null,
    };
  }

  /**
   * The rail returns a rendered card. If the digits are present as text we take them here and
   * hold them in memory only. If not, `reveal` throws and the caller falls back to human handoff.
   */
  private captureMaterial(opaqueId: string, html: string) {
    const pan = html
      .replace(/[^0-9]/g, " ")
      .match(/\b(\d{4} ?\d{4} ?\d{4} ?\d{4})\b/)?.[1]
      ?.replace(/ /g, "");
    const expiry = html.match(/\b(0[1-9]|1[0-2])\s*\/\s*(\d{2})\b/)?.[0]?.replace(/\s/g, "");
    const cvc = html.match(/CVC|CVV/i)
      ? html.replace(/\D/g, " ").match(/\b(\d{3})\b/)?.[1]
      : undefined;
    if (pan && expiry && cvc) this.material.set(opaqueId, { pan, expiry, cvc });
  }

  async reveal(opaqueId: string): Promise<CardMaterial> {
    const m = this.material.get(opaqueId);
    if (!m) throw new Error("CARD_UNREADABLE");
    return m;
  }
}
