import { assertIssuable as sharedAssertIssuable } from '@happy/shared';
import type { Cents } from '../config.js';

export type IssueRequest = { amountCents: Cents; cardholderName: string; idempotencyKey: string };

export type PreparedPayment = {
  nonce: `0x${string}`;
  envelope: string;
  validBeforeMs: number;
};

export type IssueResult = {
  opaqueId: string;
  last4: string | null;
  expiresAt: string | null;
  settlementTx: string | null;
};

/** The only type that carries card data. Never persisted, never logged, never exported. */
export type CardMaterial = { pan: string; expiry: string; cvc: string };

export interface IssuerAdapter {
  readonly name: 'mock' | 'straitsx';
  /** Probe, validate, sign. Moves no money. Persist the result before calling send(). */
  prepare(req: IssueRequest): Promise<PreparedPayment>;
  /** Irreversible. Safe to replay with the same prepared payment — the nonce is single-use on-chain. */
  send(req: IssueRequest, prepared: PreparedPayment): Promise<IssueResult>;
  reveal(opaqueId: string): Promise<CardMaterial>;
}

export const NAME_RE = /^[A-Za-z ]{2,26}$/;

/** Band check delegates to @happy/shared; the name rule is ours because only the card carries it. */
export function assertIssuable(amountCents: Cents, cardholderName: string, min = 500, max = 3000) {
  if (amountCents < min || amountCents > max) throw new Error(`amount ${amountCents} outside rail bounds ${min}-${max}`);
  sharedAssertIssuable(BigInt(amountCents));   // bigint-only: a number throws "Cannot mix BigInt and other types"
  if (!NAME_RE.test(cardholderName)) throw new Error(`cardholder_name must match ${NAME_RE}`);
}
