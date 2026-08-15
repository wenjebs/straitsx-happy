import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  assertIssuable,
  type CardMaterial, type IssueRequest, type IssueResult, type IssuerAdapter, type PreparedPayment,
} from './types.js';

function luhnComplete(prefix15: string): string {
  let sum = 0, dbl = true;
  for (let i = prefix15.length - 1; i >= 0; i--) {
    let d = prefix15.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return prefix15 + String((10 - (sum % 10)) % 10);
}

export class MockIssuer implements IssuerAdapter {
  readonly name = 'mock' as const;
  private byKey = new Map<string, { result: IssueResult; material: CardMaterial }>();
  private byOpaque = new Map<string, CardMaterial>();

  async prepare(req: IssueRequest): Promise<PreparedPayment> {
    assertIssuable(req.amountCents, req.cardholderName);
    return {
      nonce: `0x${randomBytes(32).toString('hex')}`,
      envelope: `mock:${req.idempotencyKey}`,
      validBeforeMs: Date.now() + 300_000,
    };
  }

  async send(req: IssueRequest, _prepared: PreparedPayment): Promise<IssueResult> {
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return existing.result;

    assertIssuable(req.amountCents, req.cardholderName);

    let digits = '4';
    for (let i = 0; i < 14; i++) digits += randomInt(10);
    const pan = luhnComplete(digits);
    const material: CardMaterial = { pan, expiry: '12/29', cvc: String(randomInt(100, 1000)) };

    const opaqueId = `mockcard_${randomUUID()}`;
    const result: IssueResult = {
      opaqueId,
      last4: pan.slice(-4),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      settlementTx: null,
    };
    this.byKey.set(req.idempotencyKey, { result, material });
    this.byOpaque.set(opaqueId, material);
    return result;
  }

  async reveal(opaqueId: string): Promise<CardMaterial> {
    const m = this.byOpaque.get(opaqueId);
    if (!m) throw new Error(`unknown card ${opaqueId}`);
    return m;
  }
}
