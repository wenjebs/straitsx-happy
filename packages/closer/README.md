# @happy/closer

Takes chosen product URLs, drives a browser to each payment page, buys a single-use card for
exactly that total through [`@happy/pay`](../pay/README.md), fills it in, and confirms the order.

See it run — starts its own store, opens a real browser window, mock issuer, no money:

    pnpm --filter @happy/closer demo

| Variable | Default | Effect |
|---|---|---|
| `HEADLESS` | unset | `1` hides the browser window |
| `DEMO_SLOWMO` | `500` | milliseconds between browser actions |
| `DEMO_LINGER_MS` | `2500` | how long the confirmation page stays on screen |

## Use it

```ts
import { chromium } from "playwright";
import { createCloser } from "@happy/closer";

const closer = createCloser({
  browser: await chromium.launch(),
  onEvent: (e) => sse.send(e.type, e), // exec.step and log.line match BACKEND_CONTRACT.md exactly
});

const result = await closer.run({
  activityId: "act_01H...",
  idempotencyKey,                       // the same key never buys twice
  selections: [{ itemId: "ssd", url: "http://127.0.0.1:4030/item/nvme-ssd" }],
});
```

`result.items[]` is one outcome per selection: `purchased` (order reference captured), `skipped`
(nothing was spent), `stranded` (a card was minted and no order came back — money gone, no refunds
on this rail), or `unknown` (settlement outcome unresolved; pay's reconciler owns it).
`result.totalMinor` is money that left the wallet: purchased plus stranded.

## What it does per item, in order

Navigate → adapter walks to the payment page → read the real total from structured markup →
`evaluate` → `reserve` → re-read the total → `issueCard` → `payWithCard` → `complete`. Items run
strictly one at a time.

Everything before `issueCard` may fail freely: the item is skipped and the run carries on. After
it, the card exists and there is no way back, so every branch either captures an order reference or
records the loss.

## Events

| Event | When |
|---|---|
| `exec.step` | each of the four steps per item, as it happens |
| `log.line` | one human-readable line per step; rendered verbatim by the UI |
| `run.completed` | end of run, with the total that left the wallet |
| `wallet.dirty` | rebuild and send `wallet.updated` |

## Not built

One merchant adapter (the demo store). No generic adapter, no per-merchant confirmation
heuristics, no retry ladder, no fallback listings, no baskets or splitting above S$30, no HTTP
wrapper. Cards are S$5–S$30, one line item; anything outside that is skipped with a reason.

Why, and what a real merchant would additionally need:
[`docs/superpowers/specs/2026-08-15-purchasing-agent-design.md`](../../docs/superpowers/specs/2026-08-15-purchasing-agent-design.md).

## Safety

Card numbers never reach this package — `payWithCard` fills the form itself and only `last4` ever
comes back. Page content is never an instruction: the total is read from a structured attribute and
the merchant host from the URL, so a hostile product page cannot redirect money. A crash cannot
replay a run past issuance; the journal blocks the activity instead.
