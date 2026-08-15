# Prompt draft — purchasing agent (the "Closer")

> Paste into a fresh session working in `/Users/wenjie/projects/straitsx`.

---

You are building the **purchasing agent** for a hackathon shopping assistant — the component
that takes a list of chosen product URLs, opens each one in a browser, pays with a single-use
virtual card, and confirms the order. Everything upstream (deciding *what* to buy) belongs to
other agents. Everything about *money* is already built and must not be reimplemented.

Work in `/Users/wenjie/projects/straitsx` on `main`. **Read `CLAUDE.md` first** — it carries the
payment rail's verified constraints and ten money-safety invariants, all learned the hard way.
Then read `packages/pay/README.md` (the API you'll call), `packages/pay/ARCHITECTURE.md`
(diagrams), and `frontend/BACKEND_CONTRACT.md` (what the UI expects, §6 and §7 especially).

## What you're building

Input, produced by the discovery agent:

```json
{
  "activityId": "gaming-pc-001",
  "selections": [
    { "itemId": "gpu", "url": "https://merchant.example/product/gpu-123" },
    { "itemId": "cpu", "url": "https://merchant.example/product/cpu-456" }
  ]
}
```

For each selection, in sequence: open the URL, get to the payment page, read the real final
total, buy a card for exactly that amount, fill it in, submit, capture the order reference.

## The money layer — call it, don't rebuild it

`@happy/pay` is finished, reviewed and proven twice against the live rail. Its contract:

```ts
const d = await evaluate(q);          // free, no side effects, call while comparing
if (d.decision !== 'ALLOW') return;   // NEEDS_HUMAN needs approve(id) first
const p = await reserve(q);           // holds budget, still no money moved
// ... drive the browser to the payment page, read the FINAL total ...
await issueCard(p.id, finalTotalCents);        // 💰 irreversible
const { ok, orderRef } = await payWithCard(page, p.id);   // fills the form itself
ok ? await complete(p.id, orderRef ?? null) : await cancel(p.id, 'checkout_failed');
```

`q` is `{ amountCents, merchantHost, itemName, productUrl? }`.

**Five rules you cannot bend.** Each was a real bug caught in review:

1. **Do not call `issueCard` until the browser is on the payment page.** The card expires in
   ~10 minutes and the money is irreversible.
2. **Pass the final total including shipping and tax**, not the listing price. Anything more
   than 2% above your quoted price is refused.
3. **Retry and fall back to other listings only *before* `issueCard`.** After it, a card exists
   for one specific charge; abandoning it abandons the money. There are no refunds on this rail.
4. **You never see a card number.** `payWithCard` takes your Playwright page and fills the form
   itself. Do not try to read, log, or pass a PAN.
5. **One line item, S$5–S$30 all-in.** The rail refuses anything outside that. Read
   `mandate.limits` and filter before evaluating.

## Four things to resolve, not assume

Decide these during brainstorming and record the decision with its reasoning:

1. **Where the code lives.** A new `packages/closer`? Inside `apps/api`? It has to be callable
   by whatever serves `POST /v1/activities/:id/purchase`.
2. **Merchant strategy.** `BACKEND_CONTRACT.md` implies real merchants. A generic
   `autocomplete="cc-*"` filler already exists in `payWithCard`, but navigation, cart and
   checkout differ per site. Adapter-per-merchant with a generic fallback, or generic only?
   What happens on a site that needs a login?
3. **Shopee specifically, if that's the target.** It has aggressive bot detection, mandatory
   account login, and OTP on checkout. Be blunt in the spec about whether an unattended agent
   can complete a Shopee purchase at all, and what the fallback is. Do not discover this on stage.
4. **The S$30 ceiling versus the product's numbers.** `BACKEND_CONTRACT.md` shows a S$429 GPU
   and a S$600 item cap. **Neither can be bought** — the rail mints S$5–S$30 cards and splitting
   across cards is not built. Say plainly what the demo can actually purchase, and what the UI
   should show instead.

## What the UI expects while you work

From `BACKEND_CONTRACT.md` §6: execution is **strictly sequential**, four steps per item, with
one `exec.step` and one `log.line` event emitted **as each step actually happens** — not batched
on a timer. `POST /purchase` must honour `idempotencyKey` and never buy twice. On completion emit
`activity.completed` and `wallet.updated`.

Log lines are rendered verbatim, so write them for a human:

```
card 4319 4400 issued · limit S$29.00
bizgram-asia/checkout · autofill ok
placing order S$29.00
order #SG830142 confirmed · card expired
```

Note the contract's wallet example says `"network": "Polygon"` and its mandate caps are whole
SGD. Both are mock-era artifacts — this rail is **Avalanche**, and the library speaks integer
cents. Flag the mismatch; don't silently paper over it.

## How to work — do all of this in one pass, no check-ins

The user is away and wants it finished on return. Do not stop to ask questions. Where something
is genuinely ambiguous, choose, write down the choice and its cost if wrong, and continue.

1. **Brainstorm** — resolve the four questions above. Decide the interface, the failure ladder,
   and how much per-merchant knowledge is worth encoding for one demo.
2. **Spec** → `docs/superpowers/specs/2026-08-15-purchasing-agent-design.md`. Interface, data
   flow, failure handling zone by zone, what is deliberately not built, open questions.
3. **Plan** → `docs/superpowers/plans/2026-08-15-purchasing-agent.md`. TDD, bite-sized tasks,
   real code in each step, exact file paths, and a hard demo-safe cut line.
4. **Review your own spec and plan** with fresh eyes before declaring done. Check specifically:
   does every step of the money sequence happen in the required order; can any failure path
   abandon a live card; does anything assume an item under S$30 when the product says S$429;
   would a fresh engineer be able to execute the plan without asking you anything.

Fix what the review finds, then summarise: what you decided, what you deliberately left out,
and what you need from a human.

## Constraints

- **Spend nothing.** `ISSUER=mock` for all development. The demo store at `apps/demo-store`
  (`pnpm dev`, port 4030) is your test merchant. Never point tests at the live rail.
- **Do not modify `packages/pay`.** If you believe it needs a change, write the case in your spec
  and leave it alone. It is reviewed, merged and proven.
- Do not run `git checkout -- .` — other sessions may have uncommitted work.
- `pnpm format` reformats unrelated files; revert what isn't yours before staging.
- **Commit straight to `main` with plain `git commit`.** No branches, no Graphite, no stacking —
  it is a hackathon and several people are working in this repo at once. Commit early and often
  so nobody loses work, stage only the files you touched, and pull before you push.
- `pnpm test` from the repo root must stay green — 100 tests currently pass.

## Done means

The spec and plan files exist, agree with each other, and reflect the rail's real constraints
rather than the product mock's aspirations. A fresh engineer could execute the plan without
asking a question. You have said plainly, in writing, whether an unattended agent can complete
a purchase on the intended merchant — and if it can't, what happens instead.
