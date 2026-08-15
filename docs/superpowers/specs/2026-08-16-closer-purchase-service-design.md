# The Closer as a purchase service — design

16 Aug 2026. Connects the real browser-driving Closer to Happy's buy phase.

## The problem

Happy decides *what* to buy and owns the money. It has no way to actually buy it: its
`PurchaseAgentProvider` has a `remote` mode that dispatches a listing and a card grant over HTTP,
and nothing on the other end of that HTTP.

This spec is the other end.

## What already exists, and what that rules out

`backend/src/providers/purchaseAgent.ts` is finished. `RemotePurchaseAgentProvider` already POSTs
`/v1/purchase-runs` with the exact payload we need to receive, already sends
`Authorization: Bearer <PURCHASE_AGENT_API_TOKEN>`, already enforces a 15-second timeout, and
already treats a non-2xx as a 502. `PURCHASE_AGENT_MODE=remote` plus `PURCHASE_AGENT_API_BASE_URL`
switches it on.

**So Happy's protocol is not changed by this work.** Everything lands in a new service inside
`packages/closer`. Happy gets one addition — stubbed listings, below — and nothing else.

`LocalPurchaseAgentProvider` in the same file is the reference implementation of the callback
sequence, and stays as the offline failsafe.

### This path does not use `packages/pay`

Worth stating plainly, because it inverts an assumption the repo is built on. In this design
**Happy issues the card** and hands the Closer a one-use reveal capability. The mandate check,
budget ledger, `PAYING`/`STRANDED` lifecycle and reconciliation in `packages/pay` are not in the
loop; `backend/src/services/purchases.ts` owns the equivalents.

CLAUDE.md's twelve money-safety invariants therefore do not govern this path. The ones that are
about *card material* rather than about `packages/pay`'s ledger still do, and are restated as
requirements below — invariant 10 (card material never escapes), 11 (never require a top-level
navigation after submit) and 12 (type digits, never `fill()`).

## Scope

**In:** the two HTTP endpoints, the card claim/reveal flow, the pre-card verification gate,
browser checkout through to submit, the callback stream, and an embeddable live view.

**Out, deliberately:** discovery. Happy's scouts are stubbed to five fixed product URLs. The Closer
never searches; it receives `listing.url` and buys exactly that.

**Out:** baskets, multi-item runs, refunds, retry-after-decline. One attempt, one item.

## Interface

### `POST /v1/purchase-runs`

Authenticated with `Authorization: Bearer <PURCHASE_AGENT_API_TOKEN>`. Rejects a missing or wrong
token with 401 before reading the body.

Accepts the payload Happy already sends: `activityId`, `attemptId`, `item`, `listing`, `cardGrant`,
`sandbox`, `idempotencyKey`, `amountMinor`, `callback`.

Returns **202 within 15 seconds**, having persisted the job and idempotency record. The run happens
asynchronously. A repeated `idempotencyKey` returns 202 with the existing job and starts nothing.

### `POST /v1/purchase-runs/:activityId/cancel`

Body `{ attemptId?, reason }`. Marks the attempt cancelled; the run checks for cancellation between
every step and aborts at the next one. Returns 200 even for an unknown attempt — cancelling
something already finished is not an error.

## The run

```
accept (202) ──► verify payload ──► open browser ──► browser.started + liveStreamUrl
                                          │
                                          ▼
                            navigate listing, read the REAL total
                                          │
                                          ▼
                      ┌──── verification gate ──── fails ──► purchase.failed
                      ▼
                claim card (at most once) ──► reveal ──► BLANK THE STREAM
                      │
                      ▼
                type card into the gateway iframe ──► checkout.prepared
                      │
                      ▼
                submit ──► RESUME STREAM ──► order.placing
                      │
                      ▼
                read order reference ──► order.confirmed | purchase.failed
```

### The verification gate

Runs after the page is loaded and **before the card is claimed**, so a failure costs nothing.

| Check | Why |
|---|---|
| `listing.url` is the approved listing | The agent buys what was approved, not what it found |
| Item identity and specification match | Same |
| **Merchant's displayed total ≤ `listing.amountMinor`** | Read from the page, never computed and never taken from the payload. This is the "merchant nudges the price 2% past the cap" attack |
| `cardGrant.amountMinor === listing.amountMinor` | A mismatch means Happy and the Closer disagree about the price |
| Currency is SGD | |
| Grant has not expired | |
| Listing still available | |
| Quantity is 1 | |

Any failure ⇒ `purchase.failed` with the reason, no card claimed, and **never a substitution**.
Silently buying a different item is worse than buying nothing.

### Card discipline

1. **Claim at most once per `idempotencyKey`.** Enforced by the job store, not by convention. A
   second claim for the same attempt is a bug that spends money twice.
2. Claim only when the browser is actually at the payment step. A card claimed early is a card
   burning its ten-minute TTL while we fill a shipping form.
3. Reveal with `GET <revealUrl>` and `Authorization: Bearer <agentAccess.token>`, matching Happy's
   own `/v1/dev/cards/:id`.
4. PAN, expiry and CVC exist only as locals, only long enough to type. Never in a callback, a log
   line, a trace, a screenshot, a model prompt, or on disk.
5. **The live stream is blanked** from just before reveal until after submit. See below.
6. Digits are typed with `pressSequentially`, never `fill()` — instant entry is a named fraud
   signal, and the 3DS challenge it invites kills a single-use card.
7. No top-level navigation is required after submit. A gateway's 3DS challenge is a modal iframe on
   the same page; demanding navigation turns every challenge into a timeout and a stranded card.

### The live view

`browser.started` must carry a `liveStreamUrl` that satisfies `z.url()`, Happy persists it, and the
frontend renders it in an `<iframe>`.

AgentCore's own live view cannot be used for this: its endpoint is an Amazon DCV transport that
answers `501 Not Implemented` to a plain GET, and the DCV client is a licensed AWS download rather
than an npm package. Measured — see `docs/agentcore-browser.md`.

So the Closer serves its own page: a CDP screencast streamed over SSE and painted to a canvas, the
same mechanism already proven in `demo/agentcore-server.ts`. It is a plain embeddable HTML page
with no dependencies.

**It is blanked across card entry.** From immediately before the reveal call until after submit
completes, the page shows a "card entry in progress" panel and no frames are sent. Whoever holds
that URL — and it is persisted in Happy's event log, so that is anyone who can read an activity —
never sees the number. This is invariant 10 applied to pixels rather than to code paths.

### Callbacks

`POST <callback.url>` with `Authorization: Bearer <callback.token>`.

Every event carries `eventId`, `attemptId` and `itemId`. Types, matching
`PurchaseAgentCallbackEvent` in `backend/src/schemas.ts`: `browser.started` (with `liveStreamUrl`),
`checkout.prepared`, `order.placing`, `order.confirmed` (with `orderId`), `purchase.failed` (with
`message`, `retryable`).

`eventId` is **derived, not random**: a hash of `attemptId` + event type + sequence number. A
retried callback therefore carries the same id and Happy deduplicates it. Retries use bounded
backoff, and a callback that never succeeds is logged but never aborts the run — the purchase
already happened; failing to narrate it does not un-happen it.

**An unknown outcome is `purchase.failed`, never `order.confirmed`.** Money has already moved by
then, so a fabricated order reference marks a purchase done that may never have shipped.

## Browser selection

`CLOSER_BROWSER=agentcore|local`.

`agentcore` uses `startAgentCoreSession` unchanged. `local` launches a normal Playwright Chromium,
which is what the offline tests use — AgentCore's browser runs in AWS and cannot reach
`apps/demo-store` on localhost.

Both satisfy `BrowserLike`, so `run.ts` does not know which it has.

## Stubbed listings

Happy's scouts return five fixed products instead of searching. They are real Nylon Coffee items in
the S$5–30 band, chosen because that merchant is the one we have proven end to end: it admits an
AWS datacentre IP, and its Shopify checkout serves card fields from
`checkout.pci.shopifyinc.com`, which `payWithCard` reaches.

## Testing

Offline, no AWS and no money:

- A fake Happy: a claim endpoint, a reveal endpoint and a callback sink.
- `apps/demo-store` on a local Playwright browser.

Covering: the verification gate rejecting each condition independently; idempotent re-POST starting
exactly one run; the claim-once guarantee under a concurrent duplicate; the stream being blank
across card entry; every callback type emitted in order with stable ids; cancellation aborting at
the next step; an unknown outcome reporting failure rather than success.

One manual run against Nylon Coffee over AgentCore covers the real-merchant path.

## What this does not solve

A real purchase still needs StraitsX production whitelisting for the wallet, and an answer to
whether the card's BIN is 3DS-enrolled. With `CARD_MODE=local` the PAN is `4242…`, so a real
merchant declines it — which exercises the whole path including submit and decline handling, and is
the most that can be tested before those two answers arrive.
