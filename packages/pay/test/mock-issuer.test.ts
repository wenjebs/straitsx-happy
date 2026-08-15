import { describe, it, expect } from 'vitest';
import { MockIssuer } from '../src/issuer/mock.js';

const luhnOk = (pan: string) => {
  let sum = 0, dbl = false;
  for (let i = pan.length - 1; i >= 0; i--) {
    let d = pan.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
};

describe('MockIssuer', () => {
  it('issues a card with a Luhn-valid PAN', async () => {
    const iss = new MockIssuer();
    const req = { amountCents: 1800, cardholderName: 'Happy Agent', idempotencyKey: 'p1' };
    const r = await iss.send(req, await iss.prepare(req));
    const m = await iss.reveal(r.opaqueId);
    expect(luhnOk(m.pan)).toBe(true);
    expect(m.pan).toHaveLength(16);
    expect(r.last4).toBe(m.pan.slice(-4));
  });

  it('is idempotent on the idempotency key', async () => {
    const iss = new MockIssuer();
    const req = { amountCents: 1800, cardholderName: 'Happy Agent', idempotencyKey: 'p1' };
    const a = await iss.send(req, await iss.prepare(req));
    const b = await iss.send(req, await iss.prepare(req));
    expect(b.opaqueId).toBe(a.opaqueId);
  });

  it('rejects amounts outside the rail bounds', async () => {
    const iss = new MockIssuer();
    await expect(iss.prepare({ amountCents: 499, cardholderName: 'A B', idempotencyKey: 'x' })).rejects.toThrow(/bounds/);
    await expect(iss.prepare({ amountCents: 3001, cardholderName: 'A B', idempotencyKey: 'y' })).rejects.toThrow(/bounds/);
  });

  it('rejects a cardholder name the rail would reject', async () => {
    const iss = new MockIssuer();
    await expect(iss.prepare({ amountCents: 1800, cardholderName: 'Agent 007', idempotencyKey: 'z' }))
      .rejects.toThrow(/cardholder_name/);
  });
});
