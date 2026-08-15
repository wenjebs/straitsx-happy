# @happy/pay

The money half of the Happy shopping agent. Spending rules, budget ledger, single-use
virtual card purchase over x402, card entry at checkout, on-chain reconciliation.

## Install

    pnpm add @happy/pay
    pnpm exec playwright install chromium

## Use it

```ts
import { createMandate, evaluate, reserve, issueCard, payWithCard, complete, cancel } from '@happy/pay';

await createMandate({
  perItemCents: 2500, dailyCents: 15000,
  merchants: ['shop.example.com'], expiresAt: new Date(Date.now() + 86_400_000),
});

const q = { amountCents: 1800, merchantHost: 'shop.example.com', itemName: 'Anker USB-C Hub' };
if ((await evaluate(q)).decision !== 'ALLOW') return;

const p = await reserve(q);
// drive the browser to the payment page, read the final total, then:
await issueCard(p.id, finalTotalCents);          // money leaves here, irreversibly
const { ok, orderRef } = await payWithCard(page, p.id);
ok ? await complete(p.id, orderRef ?? null) : await cancel(p.id, 'checkout_failed');
```

## Three rules for callers

1. **Do not call `issueCard` until the browser is on the payment page.** The card is
   single-use and expires about ten minutes after issuance.
2. **Pass the final total including shipping and tax**, not the item price. The mandate is
   re-checked against it, and a total more than 2% above your quote is refused.
3. **One line item, S$5–S$30 all-in.** Read `mandate.limits` and filter candidates before
   you evaluate. Splitting a larger basket across several cards is not built.

## Environment

Copy `.env.example`. `ISSUER=mock` is the default and needs nothing else — the whole flow
runs offline against a fake issuer. Only set `ISSUER=straitsx` and `SPEND_PRIVATE_KEY`
when you intend to spend real money.

## Safety notes

- Card numbers never leave this package. `payWithCard` fills the form itself; no public
  function returns card material.
- Every state change is recorded in an append-only audit log — `getAuditLog(purchaseId)`.
- Nothing polls the payment rail. It rate-limits after roughly a dozen requests and the
  limit is shared with every other team.
