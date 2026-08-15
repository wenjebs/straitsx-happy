/**
 * Three units, one bug that ruins the demo. See DESIGN.md §1.
 *
 *   amount_sgd  StraitsX API only. Human decimal, 5..30.        e.g. 18
 *   minor       Our ledger + AP2. SGD cents.                    e.g. 1800
 *   atomic      EIP-712 signing. XSGD has 6 decimals.           e.g. 18000000
 *
 * atomic === minor * 10_000n. A silent 1e4 slip approves 10,000x the intent.
 *
 * Rule: NEVER compute `atomic` yourself for a real payment. Take it from the
 * x402 challenge (`entry.amount`) and run it through `assertAtomicMatchesMinor`.
 */

export const XSGD_DECIMALS = 6;
export const MINOR_TO_ATOMIC = 10_000n; // 10^(6 - 2)

/** Hard rail limits. `amount_sgd:31` returns HTTP 400 from StraitsX. */
export const MIN_CARD_MINOR = 500n; // S$5
export const MAX_CARD_MINOR = 3000n; // S$30

export class MoneyUnitError extends Error {
  override name = "MoneyUnitError";
}

/** S$18.00 -> 1800n. Rejects sub-cent precision rather than rounding it away. */
export function sgdToMinor(amountSgd: string | number): bigint {
  const s = typeof amountSgd === "number" ? amountSgd.toString() : amountSgd.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new MoneyUnitError(`not a 2dp SGD amount: ${JSON.stringify(amountSgd)}`);
  const cents = (m[2] ?? "").padEnd(2, "0");
  return BigInt(m[1]!) * 100n + BigInt(cents);
}

/** 1800n -> "18.00". */
export function minorToSgd(minor: bigint): string {
  if (minor < 0n) throw new MoneyUnitError(`negative minor: ${minor}`);
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
}

/**
 * The only sanctioned minor -> atomic conversion, for the MOCK issuer and for
 * building expectations. On the real rail, verify instead — see below.
 */
export function minorToAtomic(minor: bigint): bigint {
  return minor * MINOR_TO_ATOMIC;
}

/**
 * Cross-check the x402 challenge against our ledger before signing anything.
 * Throws instead of returning a boolean: there is no safe "continue anyway".
 */
export function assertAtomicMatchesMinor(atomic: bigint | string, minor: bigint): void {
  const a = BigInt(atomic);
  const expected = minor * MINOR_TO_ATOMIC;
  if (a !== expected) {
    throw new MoneyUnitError(
      `x402 challenge amount ${a} != ledger ${minor} minor (expected ${expected} atomic). Refusing to sign.`,
    );
  }
}

/** Rail limits are a hard 400 from StraitsX — check before spending a round trip. */
export function assertIssuable(minor: bigint): void {
  if (minor < MIN_CARD_MINOR || minor > MAX_CARD_MINOR) {
    throw new MoneyUnitError(
      `S$${minorToSgd(minor)} is outside the issuable band S$${minorToSgd(MIN_CARD_MINOR)}..S$${minorToSgd(MAX_CARD_MINOR)}`,
    );
  }
}

/** What goes on the wire to StraitsX: a plain decimal, never atomic. */
export function minorToAmountSgd(minor: bigint): string {
  assertIssuable(minor);
  return minorToSgd(minor);
}
