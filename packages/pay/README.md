# @happy/pay

A payments library for AI shopping agents. You set the spending limits; it buys a
single-use virtual Visa card for each purchase and fills it into the merchant's checkout.

## Install

    pnpm add @happy/pay
    pnpm exec playwright install chromium

`ISSUER=mock` is the default, so the whole flow runs offline with no funding and no keys.

Diagrams of how it all fits together: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Use it

```ts
import { createMandate, evaluate, reserve, issueCard, payWithCard, complete, cancel } from '@happy/pay';

// 1. Set the limits once.
await createMandate({
  perItemCents: 2500,
  dailyCents: 15000,
  merchants: ['shop.example.com'],
  expiresAt: new Date(Date.now() + 86_400_000),
});

// 2. Check a candidate before you spend any effort on it.
const q = { amountCents: 1800, merchantHost: 'shop.example.com', itemName: 'Anker USB-C Hub' };
if ((await evaluate(q)).decision !== 'ALLOW') return;

// 3. Hold the budget.
const p = await reserve(q);

// 4. Drive the browser to the payment page and read the real total. Then:
await issueCard(p.id, finalTotalCents);   // money leaves here, irreversibly
const { ok, orderRef } = await payWithCard(page, p.id);
ok ? await complete(p.id, orderRef ?? null) : await cancel(p.id, 'checkout_failed');
```

## API

**Limits**

| | |
|---|---|
| `createMandate({ perItemCents, dailyCents, merchants, expiresAt })` | Set the spending limits. Replaces any existing mandate. |
| `getMandate()` | The mandate plus what's been spent, reserved, and what's left. |
| `revokeMandate(reason)` | Kill switch. Every later decision is denied. |

**Buying**

| | |
|---|---|
| `evaluate(quote)` | `ALLOW` / `NEEDS_HUMAN` / `DENY` with a reason. Changes nothing. |
| `reserve(quote)` | Same check, but holds the budget and returns a purchase. Throws `MandateError` on `DENY`. |
| `approve(purchaseId)` | Your human said yes to a `NEEDS_HUMAN` purchase. |
| `issueCard(purchaseId, finalTotalCents)` | Buys the card. Returns `{ last4, expiresAt, settlementTx }`. Calling it again for the same purchase returns the same card and sends nothing — but it throws if a previous attempt is still unresolved, rather than risking a second payment. |
| `payWithCard(page, purchaseId)` | Fills the card into the checkout form on a Playwright page. Returns `{ ok, orderRef?, error? }`. |
| `complete(purchaseId, orderRef)` | The order went through. |
| `cancel(purchaseId, reason)` | It didn't. Releases the budget, or marks it stranded if a card was already bought. Throws on a purchase that is already finished — spent money must stay on the books. |

A quote is `{ amountCents, merchantHost, itemName, productUrl? }`.

**Looking at things**

| | |
|---|---|
| `getPurchase(id)` / `listPurchases(limit?)` | Purchase state, amounts, card last 4, settlement tx. |
| `getAuditLog(purchaseId)` | Every state change, in order. |
| `getWallet()` | Address, balance, available. `null` fields in mock mode. |
| `health()` | Whether issuing would work right now, and what's blocking it. Never touches the network. |
| `shutdown()` | Stop the background timers. Tests and clean exits. |

## Three rules for callers

1. **Don't call `issueCard` until the browser is on the payment page.** The card is
   single-use and expires about ten minutes after it's issued.
2. **Pass the final total, including shipping and tax** — not the item price. It's
   re-checked against your limits, and anything more than 2% above your quote is refused.
3. **One line item, S$5–S$30 all-in.** Read `mandate.limits` and filter candidates before
   you evaluate.

## Environment

Copy `.env.example`. `ISSUER=mock` needs nothing else. Set `ISSUER=straitsx` and
`SPEND_PRIVATE_KEY` only when you intend to spend real money.

## Safety

- Card numbers never leave this package. `payWithCard` fills the form itself; no public
  function returns card material, and none of it reaches the audit log.
- Every state change is appended to an audit log you can read back.
- A crash can't pay twice or lose a payment — a background reconciler settles anything
  in flight against the chain.
- Nothing polls the payment rail. It rate-limits after roughly a dozen requests, and the
  limit is shared with everyone else at the venue.
- When the real issuer returns a card, the raw response is written to `card-responses/`
  with owner-only permissions, so a failed number-extraction doesn't lose the card — those
  files hold live card data and should be deleted once the card is spent.

## Not built

Baskets (one card, one item), refunds, retries onto a second card, and any HTTP service
wrapper — this is a library you call in-process.
