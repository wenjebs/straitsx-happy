import type { Cents, Config } from './config.js';

export type Reason =
  | 'OVER_PER_ITEM_CAP' | 'OVER_DAILY_CAP' | 'MERCHANT_NOT_ALLOWED'
  | 'MANDATE_EXPIRED' | 'MANDATE_INACTIVE'
  | 'BELOW_RAIL_MINIMUM' | 'ABOVE_RAIL_MAXIMUM'
  | 'NOT_ENOUGH_MONEY' | 'CHAIN_STALE' | 'PRICE_CHANGED'
  | 'RAIL_RATE_LIMITED' | 'RAIL_DOWN';

export type Decision =
  | { decision: 'ALLOW' }
  | { decision: 'NEEDS_HUMAN'; reason: Reason }
  | { decision: 'DENY'; reason: Reason };

export type DecisionInput = {
  amountCents: Cents;
  merchantHost: string;
  /** present only at issue time; enables the anti-overcharge guard */
  quotedCents?: Cents;
};

export type DecisionContext = {
  config: Pick<Config, 'minCardCents' | 'maxCardCents' | 'priceToleranceBps' | 'chainStaleMs'>;
  now: number;
  mandate: {
    id: string;
    status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
    expiresAtMs: number;
    perItemCents: Cents;
    dailyCents: Cents;
    merchants: string[];
  } | null;
  spentCents: Cents;
  reservedCents: Cents;
  /** this purchase's own existing reservation, excluded from committed totals */
  ownReservationCents: Cents;
  balanceCents: Cents;
  balanceAgeMs: number;
};

const deny = (reason: Reason): Decision => ({ decision: 'DENY', reason });

export function decide(input: DecisionInput, ctx: DecisionContext): Decision {
  const { config: cfg, mandate: m } = ctx;

  if (!m) return deny('MANDATE_INACTIVE');
  if (m.status !== 'ACTIVE') return deny('MANDATE_INACTIVE');
  if (ctx.now > m.expiresAtMs) return deny('MANDATE_EXPIRED');

  if (input.amountCents < cfg.minCardCents) return deny('BELOW_RAIL_MINIMUM');
  if (input.amountCents > cfg.maxCardCents) return deny('ABOVE_RAIL_MAXIMUM');

  if (!m.merchants.includes(input.merchantHost)) return deny('MERCHANT_NOT_ALLOWED');

  if (input.quotedCents !== undefined) {
    const ceiling = input.quotedCents + Math.floor((input.quotedCents * cfg.priceToleranceBps) / 10_000);
    if (input.amountCents > ceiling) return deny('PRICE_CHANGED');
  }

  const committed = ctx.spentCents + ctx.reservedCents - ctx.ownReservationCents;
  if (committed + input.amountCents > m.dailyCents) return deny('OVER_DAILY_CAP');

  if (ctx.balanceAgeMs > cfg.chainStaleMs) return deny('CHAIN_STALE');
  const available = ctx.balanceCents - (ctx.reservedCents - ctx.ownReservationCents);
  if (available < input.amountCents) return deny('NOT_ENOUGH_MONEY');

  if (input.amountCents > m.perItemCents) return { decision: 'NEEDS_HUMAN', reason: 'OVER_PER_ITEM_CAP' };

  return { decision: 'ALLOW' };
}
