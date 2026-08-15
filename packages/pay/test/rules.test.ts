import { describe, it, expect } from 'vitest';
import { decide } from '../src/rules.js';

const cfg = { minCardCents: 500, maxCardCents: 3000, priceToleranceBps: 200, chainStaleMs: 60_000 } as any;

const ctx = (over: Partial<any> = {}) => ({
  config: cfg,
  now: Date.parse('2026-08-15T12:00:00Z'),
  mandate: {
    id: 'm1', status: 'ACTIVE' as const, expiresAtMs: Date.parse('2026-08-20T00:00:00Z'),
    perItemCents: 2500, dailyCents: 15000, merchants: ['shop.example.com'],
  },
  spentCents: 0,
  reservedCents: 0,
  ownReservationCents: 0,
  balanceCents: 10000,
  balanceAgeMs: 1000,
  ...over,
});

const q = (over: Partial<any> = {}) => ({ amountCents: 1800, merchantHost: 'shop.example.com', ...over });

describe('decide', () => {
  it('allows a normal purchase', () => {
    expect(decide(q(), ctx())).toEqual({ decision: 'ALLOW' });
  });

  it('denies below the rail minimum', () => {
    expect(decide(q({ amountCents: 499 }), ctx())).toEqual({ decision: 'DENY', reason: 'BELOW_RAIL_MINIMUM' });
  });

  it('denies above the rail maximum', () => {
    expect(decide(q({ amountCents: 3001 }), ctx())).toEqual({ decision: 'DENY', reason: 'ABOVE_RAIL_MAXIMUM' });
  });

  it('denies an unlisted merchant', () => {
    expect(decide(q({ merchantHost: 'evil.example.com' }), ctx()))
      .toEqual({ decision: 'DENY', reason: 'MERCHANT_NOT_ALLOWED' });
  });

  it('denies everything when the allowlist is empty', () => {
    expect(decide(q(), ctx({ mandate: { ...ctx().mandate, merchants: [] } })))
      .toEqual({ decision: 'DENY', reason: 'MERCHANT_NOT_ALLOWED' });
  });

  it('needs a human above the per-item cap', () => {
    expect(decide(q({ amountCents: 2600 }), ctx()))
      .toEqual({ decision: 'NEEDS_HUMAN', reason: 'OVER_PER_ITEM_CAP' });
  });

  it('excludes the purchase own reservation from the daily total', () => {
    // Daily cap is exactly one purchase wide. Without the exclusion this double-counts
    // the purchase's own reservation and denies the very purchase that reserved it.
    const tight = { ...ctx().mandate, dailyCents: 2500 };
    const d = decide(q({ amountCents: 2500 }),
      ctx({ mandate: tight, reservedCents: 2500, ownReservationCents: 2500 }));
    expect(d).toEqual({ decision: 'ALLOW' });
    // and with the exclusion absent, the same numbers must deny
    const without = decide(q({ amountCents: 2500 }),
      ctx({ mandate: tight, reservedCents: 2500, ownReservationCents: 0 }));
    expect(without).toEqual({ decision: 'DENY', reason: 'OVER_DAILY_CAP' });
  });

  it('denies over the daily cap once other reservations are counted', () => {
    // 10000 spent + 3000 reserved elsewhere + 2400 asked = 15400 > 15000.
    // Kept under the per-item cap so OVER_DAILY_CAP fires rather than the NEEDS_HUMAN band.
    expect(decide(q({ amountCents: 2400 }), ctx({ spentCents: 10000, reservedCents: 3000 })))
      .toEqual({ decision: 'DENY', reason: 'OVER_DAILY_CAP' });
  });

  it('denies when the balance cache is stale, distinctly from insufficient funds', () => {
    expect(decide(q(), ctx({ balanceAgeMs: 61_000 })))
      .toEqual({ decision: 'DENY', reason: 'CHAIN_STALE' });
  });

  it('subtracts other open reservations from available balance', () => {
    // balance 3000, another reservation holds 2500, asking for 2000
    expect(decide(q({ amountCents: 2000 }), ctx({ balanceCents: 3000, reservedCents: 2500, dailyCents: 100000 })))
      .toEqual({ decision: 'DENY', reason: 'NOT_ENOUGH_MONEY' });
  });

  it("excludes the purchase's own reservation from available balance", () => {
    // Balance is exactly one purchase wide, held entirely by this purchase's own
    // reservation. Without the exclusion this double-counts the hold against itself
    // and denies the very purchase that placed it. Daily cap is left loose so this
    // stays isolated to the balance branch rather than passing for the wrong reason.
    const d = decide(q({ amountCents: 2000 }),
      ctx({ balanceCents: 2000, reservedCents: 2000, ownReservationCents: 2000 }));
    expect(d).toEqual({ decision: 'ALLOW' });
    // and with the exclusion absent, the same numbers must deny
    const without = decide(q({ amountCents: 2000 }),
      ctx({ balanceCents: 2000, reservedCents: 2000, ownReservationCents: 0 }));
    expect(without).toEqual({ decision: 'DENY', reason: 'NOT_ENOUGH_MONEY' });
  });

  it('denies a price that moved beyond tolerance, at issue time only', () => {
    expect(decide(q({ amountCents: 1900, quotedCents: 1800 }), ctx()))
      .toEqual({ decision: 'DENY', reason: 'PRICE_CHANGED' });
    expect(decide(q({ amountCents: 1836, quotedCents: 1800 }), ctx()).decision).toBe('ALLOW');
  });

  it('denies an expired mandate', () => {
    expect(decide(q(), ctx({ now: Date.parse('2026-08-21T00:00:00Z') })))
      .toEqual({ decision: 'DENY', reason: 'MANDATE_EXPIRED' });
  });

  it('denies a revoked mandate', () => {
    expect(decide(q(), ctx({ mandate: { ...ctx().mandate, status: 'REVOKED' } })))
      .toEqual({ decision: 'DENY', reason: 'MANDATE_INACTIVE' });
  });
});
