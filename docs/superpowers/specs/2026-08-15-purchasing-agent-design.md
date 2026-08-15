# The Closer — purchasing agent design

**Date:** 15 Aug 2026
**Status:** design, approved by nobody. Written in one pass while the author was away, per
`docs/prompts/purchasing-agent-brief.md`. Every ambiguity is resolved below with the decision and
what it costs if the decision is wrong.
**Brief:** take chosen product URLs, drive a browser to each payment page, buy a single-use virtual
card for exactly that total, fill it in, confirm the order.
**Depends on:** `@happy/pay` (finished, proven twice on the live sandbox rail — do not modify),
`CLAUDE.md` (verified rail facts and the ten money-safety invariants),
`frontend/BACKEND_CONTRACT.md` §6–§7 (what the UI expects during execution).

---

## 1. Scope

**In:** for a list of already-chosen listings, get to the payment page, issue one card per item at
the real final total, fill and submit, capture the order reference, report what happened, and emit
the events the execution screen animates from.

**Out:** deciding *what* to buy (discovery agent), serving HTTP (the API app), the SSE transport
(the API app), anything about money mechanics (`@happy/pay` owns all of it).

The Closer is a **library**, not a service. It exposes one function that the thing serving
`POST /v1/activities/:id/purchase` calls in-process.

### The one-paragraph summary

`createCloser({ browser, onEvent })` returns an object with `run(request)`. `run` walks the
selections strictly one at a time. Per item it opens the listing, drives a merchant adapter to the
payment page, reads the real all-in total from structured markup, checks it against the mandate,
reserves budget, re-reads the total, issues the card, lets `payWithCard` fill and submit, then
either completes the purchase against a real order reference or strands it loudly. Everything
before `issueCard` may fail freely and cheaply. Nothing after it may be abandoned.

---

## 2. Decisions

Each decision states the choice, the reasoning, and the cost if it turns out to be wrong.

### D1 — The code lives in a new package, `packages/closer`

`apps/api` is deliberately domain-free ("Health endpoint and the zod env schema. No domain logic —
deliberately"), and `packages/pay` is off limits. A third package keeps the browser-driving code
testable without an HTTP server in the loop and keeps `playwright` out of the API's dependency
graph until the API actually wants it.

Published as `@happy/closer`, `exports: { ".": "./src/index.ts" }`, no build step — exactly the
shape `@happy/pay` and `@happy/demo-store` already use.

*Cost if wrong:* a package manifest and a directory rename. Nothing depends on the location.

### D2 — Merchant strategy: an adapter registry with a generic fallback, and only one real adapter for the demo

`payWithCard` already handles the card fields via `autocomplete="cc-*"` heuristics. What it does
**not** handle is everything around them: finding the buy button, the cart, the shipping form, the
total, and whether the order actually went through. Those differ per site and cannot be guessed
safely, because guessing wrong *after* a card exists costs real money.

So: a small `MerchantAdapter` interface, a registry matched on hostname, one adapter for
`apps/demo-store`, and a `generic` adapter that works only on the narrow class of sites where a
product page links straight to a card form. The generic adapter is allowed to give up; giving up
before issuance is free.

**Sites that need a login are not supported.** The adapter's `toPaymentPage` throws
`PRECHECK_FAILED`, the item is skipped before any reservation, and a `SYS` log line says so. We do
not store merchant credentials, and we do not want a demo that depends on an account surviving a
bot check.

*Cost if wrong:* if the demo merchant turns out to need per-site knowledge we did not encode, that
item is skipped rather than mis-bought. The failure is visible and free.

### D3 — Shopee is not a viable target. See §9 for the full argument and the fallback ladder.

### D4 — The demo buys items of S$5–S$30. The product's S$429 GPU cannot be bought at all. See §10.

### D5 — `NEEDS_HUMAN` items are skipped, not queued

`evaluate` can return `NEEDS_HUMAN` (amount over the mandate's per-item cap). Resolving it requires
`approve(purchaseId)` — and `BACKEND_CONTRACT.md` has **no endpoint that could call it**. There is
no UI path for a human to say yes mid-run, and the run is unattended by design.

So `NEEDS_HUMAN` is treated as a skip with reason `NEEDS_HUMAN`, logged as a `SYS` line naming the
amount and the cap. To keep it from ever firing in the demo, the mandate should be created with
`perItemCents === maxCardCents` (3000): anything the rail can mint is under the cap, so the only
way to reach `NEEDS_HUMAN` is to deliberately tighten the mandate mid-run.

*Cost if wrong:* an item a human would have approved is not bought, and the UI shows it skipped
with the reason. Recoverable by re-running with a higher cap; never a wrong purchase.

### D6 — Idempotency is a journal file, and it is written before every irreversible step

`POST /purchase` carries an `idempotencyKey` and must never buy twice. The Closer keeps a JSON
journal per activity, written with write-temp-then-rename, updated *before* each reserve and
*before* each `issueCard`, and again after each terminal transition.

- Same key, run still in flight → return the in-flight promise (single-flight per activity).
- Same key, run finished → return the stored result. No browser opens, no money moves.
- **Different** key on an activity that already has a finished run → refuse with a human-readable
  error. A second key is how "buy it again" arrives, and buying the same activity twice on a rail
  with no refunds is the exact failure the contract's idempotency rule exists to prevent.
- Process restart with a journal entry in `issuing` → refuse to re-run that activity and report the
  purchase's real state from `getPurchase()`. `@happy/pay`'s reconciler owns resolving it.

In-memory alone was rejected: a crash between `reserve` and `issueCard`, followed by the frontend's
user hitting purchase again, would mint a second card for an item that may already have been
bought. The journal is ~60 lines and removes that whole class.

*Cost if wrong:* a stale journal file blocks a legitimate re-run of an activity until someone
deletes it. That is the safe direction to be wrong in.

### D7 — The Closer emits its own event type; the API maps it to SSE

`onEvent` receives `exec.step`, `log.line`, `run.completed` and `wallet.dirty`. The first two carry
payloads shaped exactly like `ExecutionRow` and `LogLine` in `frontend/src/lib/Api.ts`, so the API's
mapping is `{ event: e.type, data: { row } }` with no translation.

`wallet.updated` needs the full `Wallet` object — address, network, card list, transaction list —
which is the API's vocabulary, not the Closer's. The Closer says "the wallet changed"; the API
builds and sends it. A helper `buildWalletView()` that assembles that object from `@happy/pay` is
specified in §11 as an optional export, below the cut line.

*Cost if wrong:* the API author writes twenty lines of mapping instead of zero.

---

## 3. Interface

```ts
// packages/closer/src/types.ts

/** One chosen listing, produced by the discovery agent. */
export type Selection = {
  itemId: string;
  url: string;
  /** Item short tag for log lines, e.g. "GPU". Defaults to itemId.toUpperCase(). */
  tag?: string;
  /** 0-5, assigned by the activity in creation order. Defaults to the selection's index % 6. */
  hueIndex?: number;
  /** What the shortlist showed, in cents. Advisory only — the page is the authority. */
  expectedMinor?: number;
  itemName?: string;
};

export type PurchaseRequest = {
  activityId: string;
  idempotencyKey: string;
  selections: Selection[];
};

export type ItemStatus =
  | 'purchased'   // DONE, order reference captured
  | 'skipped'     // never reserved, or released before issuance — no money moved
  | 'stranded'    // card issued, no order — money gone, nothing bought
  | 'unknown';    // settlement outcome unresolved; the reconciler owns it

export type ItemOutcome = {
  itemId: string;
  status: ItemStatus;
  reason?: string;           // machine reason: 'ABOVE_RAIL_MAXIMUM', 'PRECHECK_FAILED', 'DECLINED'…
  purchaseId?: string;
  orderRef?: string | null;
  amountMinor?: number;      // what the card was minted for
  last4?: string | null;
};

export type RunResult = {
  activityId: string;
  idempotencyKey: string;
  items: ItemOutcome[];
  /** Money that left the wallet: purchased + stranded. See §10.3. */
  totalMinor: number;
  startedAt: string;
  finishedAt: string;
  /** True when the run stopped early because a settlement outcome was unknown. */
  aborted: boolean;
};
```

```ts
// packages/closer/src/index.ts

export type CloserEvent =
  | { type: 'exec.step'; row: { itemId: string; step: 0 | 1 | 2 | 3 | 4; state: 'queued' | 'live' | 'purchased' } }
  | { type: 'log.line'; line: { id: string; ts: string; tag: string; hueIndex: number; text: string } }
  | { type: 'run.completed'; completedAt: string; totalMinor: number }
  | { type: 'wallet.dirty' };

export type CloserDeps = {
  /** A Playwright browser the caller owns and closes. */
  browser: BrowserLike;
  onEvent: (e: CloserEvent) => void;
  /** Defaults to the real @happy/pay module. Tests inject a fake. */
  pay?: PayApi;
  /** Defaults to [demoStoreAdapter, genericAdapter]. First match wins. */
  adapters?: MerchantAdapter[];
  /** Defaults to a file journal under CLOSER_JOURNAL_DIR (./closer-runs). */
  journal?: Journal;
  shipping?: ShippingProfile;
  /** Milliseconds allowed for everything before issuance, per item. Default 90_000. */
  preIssueBudgetMs?: number;
  now?: () => number;
};

export function createCloser(deps: CloserDeps): { run(req: PurchaseRequest): Promise<RunResult> };
```

`PayApi` is a structural subset of `@happy/pay`'s exports — `getMandate`, `evaluate`, `reserve`,
`issueCard`, `payWithCard`, `complete`, `cancel`, `getPurchase`. Declaring it as an interface is
what makes the failure ladder testable: a fake can throw from `issueCard` *after* leaving the
purchase in `PAYING`, which is the one path we most need tests for and cannot provoke against the
real library without spending money.

```ts
export interface MerchantAdapter {
  readonly name: string;
  matches(url: URL): boolean;
  /** Product page → loaded payment page with the card form visible. May fill shipping and
   *  contact fields. MUST NOT submit the order. Throws to abandon the item (free — pre-issuance). */
  toPaymentPage(page: Page, ctx: AdapterContext): Promise<void>;
  /** The all-in total in cents, read from structured markup — never from merchant prose. */
  readFinalTotalCents(page: Page): Promise<number>;
  /** Called ONLY after payWithCard returned {ok:false,error:'TIMEOUT'}: did the order actually
   *  land? Return an order reference, or null for "not confirmed". See §11.1. */
  confirmOutcome?(page: Page): Promise<string | null>;
}

export type AdapterContext = {
  shipping: ShippingProfile;
  log: (text: string) => void;
  /** Absolute deadline (epoch ms) for pre-issuance work on this item. */
  deadlineAt: number;
};
```

---

## 4. Data flow, one item

Strictly sequential — the contract requires it (§6: "four steps per item, one item at a time"), and
so does the rail: the shared rate limit is roughly a dozen POSTs for the whole venue, and
`@happy/pay`'s token bucket is sized for a single caller.

| Zone | What happens | Purchase state after | Money at risk |
|---|---|---|---|
| Z0 | journal check, `exec.step {step:0,state:'queued'}` | — | none |
| Z1 | open listing → `adapter.toPaymentPage` → `readFinalTotalCents`; `exec.step 1 live` | — | none |
| Z2 | band filter → `evaluate` → `reserve` | `RESERVED` | none (budget held, no spend) |
| Z3 | re-read the total off the settled page; guard band + 2% tolerance | `RESERVED` | none |
| Z4 | `issueCard(id, finalTotal)`; `exec.step 2 live` | `PAYING` → `CARD_ISSUED` | **irreversible** |
| Z5 | `payWithCard(page, id)` fills, submits, waits; `exec.step 3 live` | `CARD_ISSUED` | spent |
| Z6 | `complete` on a real order ref, else `cancel` → `STRANDED`; `exec.step 4 purchased` | `DONE` / `STRANDED` | settled |

Two properties this ordering exists to guarantee, both straight out of `CLAUDE.md`:

1. **Spend is recognised at issuance** (invariant 5). Z4 is the money event, not Z6. Everything
   that can be checked is checked before Z4, and nothing after Z4 is allowed to walk away.
2. **The total that mints the card is the one on the payment page** (invariant 6, brief rule 2).
   Z1 reads it, Z3 re-reads it immediately before minting, and `@happy/pay` re-decides against the
   quote with a 2% tolerance inside `issueCard`. A merchant that adds shipping after we quote is
   caught in Z3 for free; a merchant that nudges the price 2% past the cap is caught by pay itself.

### Why Z3 exists at all

Between the Z1 read and the Z4 mint there is a `reserve` round-trip and, on a real merchant, often
a shipping-method selection that rewrites the total. Re-reading costs one DOM query and converts an
"issued a card for the wrong amount" into a free skip. `PRICE_CHANGED` from pay's own guard would
also catch it — but only by throwing at issuance, which is a worse place to find out.

### The merchant host comes from the URL, never the page

`merchantHost = new URL(page.url()).hostname`, lowercased, read after navigation settles. Page
content never determines where money goes. See §12.

---

## 5. Failure handling, zone by zone

The ladder below is exhaustive by construction: it is keyed on the purchase's own state machine,
which has exactly the states `RESERVED | PAYING | CARD_ISSUED | DONE | STRANDED | RELEASED | FAILED`.

### Z1 — before any reservation (navigation, adapter, total read)

| Failure | Action | Run continues |
|---|---|---|
| No adapter matches the host | skip, `reason: 'NO_ADAPTER'` | yes |
| `toPaymentPage` throws (login wall, layout changed, out of stock) | retry once, then skip, `reason: 'PRECHECK_FAILED'` | yes |
| Total unreadable / not an integer number of cents | skip, `reason: 'TOTAL_UNREADABLE'` | yes |
| Pre-issue deadline exceeded | skip, `reason: 'TIMEOUT_PRE_ISSUE'` | yes |

Retry policy: **one** retry, Z1 only, fresh page. Retrying here is free; retrying anywhere later is
not, and there is no point at which a retry may re-enter Z4 (money-safety invariants 2 and 3 —
`prepare()`/`send()` separation exists so a retry cannot sign a second nonce, and the only legal
retry of a payment is `@happy/pay` replaying its own stored envelope).

Falling back to another listing is also a Z1-only concept, and the Closer does not do it: it has no
alternates. The shortlist's reject-and-re-search path is the human's lever, and it happens before
`POST /purchase`.

### Z2 — reserving

| Failure | Action | Run continues |
|---|---|---|
| Total outside `mandate.limits` (S$5–S$30) | skip, `reason: 'BELOW_RAIL_MINIMUM'` / `'ABOVE_RAIL_MAXIMUM'` | yes |
| `evaluate` → `DENY` | skip with pay's reason verbatim | yes |
| `evaluate` → `NEEDS_HUMAN` | skip, `reason: 'NEEDS_HUMAN'` (D5) | yes |
| `reserve` throws `MandateError` (raced daily cap) | skip with the reason | yes |
| `reserve` throws anything else | skip, `reason: 'RESERVE_FAILED'` | yes |

No money has moved in any row of that table. `RESERVED` purchases that we walk away from are
cancelled explicitly (`cancel` → `RELEASED`); pay's TTL sweep would eventually do it anyway, but
leaving budget held for 15 minutes during a demo starves later items.

### Z3 — reserved, not yet issued

| Failure | Action | Run continues |
|---|---|---|
| Re-read total ≠ Z1 total, and outside quote + 2% | `cancel(id,'price_changed')` → `RELEASED`, skip | yes |
| Re-read total outside the rail band | `cancel(id,'out_of_band')` → `RELEASED`, skip | yes |
| Page navigated away / card form gone | `cancel(id,'payment_page_lost')` → `RELEASED`, skip | yes |

`cancel` on a `RESERVED` purchase writes `RELEASED` and returns the budget. This is the last zone
in which cancelling is safe, and the code comments say so at the call site.

### Z4 — issuance: the irreversible step

`issueCard` can reject *before* it sends anything (mandate re-decision, missing approval, an
unresolved earlier payment) or *after* (network died mid-settlement). **The caller cannot tell
which from the error.** So the recovery is driven by the purchase's own state, read back from pay:

```ts
try {
  card = await pay.issueCard(p.id, finalCents);
} catch (err) {
  const state = (await pay.getPurchase(p.id))?.state;
  if (state === 'RESERVED') {
    // Nothing was transmitted: markPaying() runs before send() and did not happen.
    await pay.cancel(p.id, 'issue_failed');        // → RELEASED, budget returned
    return skip(item, 'ISSUE_REFUSED', err);        // run continues
  }
  if (state === 'PAYING') {
    // Invariant 4: PAYING is untouchable — nobody knows whether the money left.
    // cancel() would throw; calling it would be a bug, not a safety net.
    return abortRun(item, 'SETTLEMENT_UNKNOWN', err);
  }
  if (state === 'CARD_ISSUED') {
    // The card exists and the money is gone. The only useful move is to try to get the goods.
    return continueToZ5();
  }
  throw err;  // unreachable by pay's state machine; crash rather than guess
}
```

`abortRun` stops the whole run: it marks this item `unknown`, emits a loud `SYS` log line, and does
not start the next item. Continuing would be *safe* for the ledger — `PAYING` counts as reserved
and pay re-decides at every issuance — but an unknown settlement almost always means the rail is
down, rate-limited, or the wallet is dry, and the next item would burn another attempt into the
same wall. Remaining items are reported `skipped` with `reason: 'RUN_ABORTED'`.

*Cost if wrong:* a transient blip aborts a run that would have completed. The user re-runs with the
same idempotency key; already-purchased items are returned from the journal and not bought again.

### Z5 / Z6 — card live, order not yet confirmed

The card exists. There is no way back. Every branch below either gets the goods or records the loss.

| `payWithCard` result | Action | Item status |
|---|---|---|
| `{ok:true, orderRef}` | `complete(id, orderRef)` | `purchased` |
| `{ok:false, error:'TIMEOUT'}` | `adapter.confirmOutcome(page)` → ref? `complete` : `cancel(id,'no_confirmation')` | `purchased` / `stranded` |
| `{ok:false, error:'DECLINED'}` | `cancel(id,'declined')` | `stranded` |
| `{ok:false, error:'FIELDS_NOT_FOUND'}` | `cancel(id,'fields_not_found')` | `stranded` |
| `{ok:false, error:'CARD_UNREADABLE'}` | `cancel(id,'card_unreadable')` | `stranded` |
| `payWithCard` throws | `cancel(id,'checkout_threw')` | `stranded` |

Notes that matter:

- **`stranded` is not a bug being swallowed.** Invariant 9: no refunds exist, so money spent with
  nothing bought stays counted as spent. `cancel` on a `CARD_ISSUED` purchase writes `STRANDED`,
  kills the card, and keeps the amount in `spentCents`. The Closer's job is to make that loud: a
  `SYS` log line naming the amount and the last four, and a non-`purchased` status in the result.
- **An unknown outcome is never reported as success** (invariant 8). `confirmOutcome` is not a
  loophole: it is a second, adapter-specific *observation* of the same page, and it must return a
  real order reference or null. It may not return "probably fine".
- **Cancelling a finished purchase throws** (invariant 7), so `complete` and `cancel` are mutually
  exclusive on every path and never both attempted.
- The card's ~10 minute TTL is not a reason to abandon anything. If more than 8 minutes have
  elapsed since issuance when we reach Z5, the Closer logs a warning and submits anyway. Abandoning
  a live card guarantees the loss; submitting late merely risks it.

### Run-level failures

| Failure | Action |
|---|---|
| Browser dies mid-run | if a purchase is `CARD_ISSUED`, `cancel` → `STRANDED` and log; then abort |
| Journal write fails | abort **before** the step it was protecting; never proceed unjournalled into Z4 |
| Duplicate key while running | return the in-flight promise |
| New key on a completed activity | reject with `'this activity has already been purchased'` |

---

## 6. Events and log lines

One `exec.step` and one `log.line` per real step, emitted as it happens (contract §5: batching
collapses the animation). The Closer never emits on a timer and never re-emits an unchanged row.

| Step | `exec.step` | `log.line` text |
|---|---|---|
| 0 | `{step:0,state:'queued'}` | — |
| 1 | `{step:1,state:'live'}` | `127.0.0.1/checkout · total S$29.00` |
| 2 | `{step:2,state:'live'}` | `card •••• 4402 issued · limit S$29.00` |
| 3 | `{step:3,state:'live'}` | `placing order S$29.00` |
| 4 | `{step:4,state:'purchased'}` | `order #ord_1a2b3c confirmed · card spent` |

The contract's example reads `card 4319 4400 issued`, i.e. first four and last four. **We only ever
have the last four** — `@happy/pay` returns `last4` and nothing else, by design (invariant 10:
card material never leaves the library). The mask is `•••• 4402`. This is a deliberate, visible
difference from the mock's line and should not be "fixed" by finding a way to surface a BIN.

Failure and skip lines use `tag: 'SYS'`, `hueIndex: 0`:

```
gpu skipped · S$429.00 is over the S$30 card ceiling
ssd skipped · merchant needs a login
S$29.00 spent · no order confirmation · card •••• 4402 stranded
settlement outcome unknown · run stopped · reconciler will resolve pur_9f3c
```

`LogLine.id` is `l_<activityId>_<seq>` with a monotonic per-run counter; `ts` is local `HH:MM:SS`.
`hueIndex` comes from the selection, defaulting to its index modulo 6.

`run.completed` carries `totalMinor` and an ISO `completedAt`; the API turns it into the contract's
`activity.completed` (whose `completedAt` is a display string — the API formats it) and, after
rebuilding the wallet, `wallet.updated`.

---

## 7. Idempotency and crash recovery

Journal file, one per activity, at `${CLOSER_JOURNAL_DIR ?? './closer-runs'}/<activityId>.json`,
mode 0600, gitignored. It holds no card material — item ids, purchase ids, states, order refs.

```jsonc
{
  "activityId": "act_01H...",
  "idempotencyKey": "idem-7c1f",
  "startedAt": "2026-08-15T14:41:02.113Z",
  "state": "running",            // running | finished | aborted
  "items": [
    { "itemId": "hub", "state": "done", "purchaseId": "pur_1", "amountMinor": 1800, "orderRef": "ord_a1b2" },
    { "itemId": "ssd", "state": "issuing", "purchaseId": "pur_2", "amountMinor": 2900 }
  ],
  "result": null                 // the RunResult once finished
}
```

Write points, all before the step they protect: `running` at run start; `reserving` before
`reserve`; `reserved` after; **`issuing` before `issueCard`**; `done` / `stranded` / `unknown` /
`skipped` after the terminal transition; `finished` with the full `RunResult` at the end. Writes are
temp-file + `rename`, so a torn write is impossible.

On construction the Closer reads the journal directory. An activity whose journal says `issuing` is
poisoned: `run` refuses it and reports `getPurchase(purchaseId).state` in the error text, so a human
can see whether the reconciler settled it. In `ISSUER=mock`, note that the mock issuer holds card
material in a `Map` in process memory — a restart loses it, `payWithCard` returns
`CARD_UNREADABLE`, and the item strands. That is mock-only; the real issuer persists the response
to `card-responses/`.

---

## 8. Merchant adapters

### 8.1 `demoStoreAdapter` — the one we actually run

Matches `127.0.0.1`, `localhost`, and `$DEMO_STORE_URL`'s host.

- `toPaymentPage`: if the URL is `/item/:sku`, click `a[href^="/checkout"]`; if it is already
  `/checkout`, do nothing. Wait for `input[autocomplete="cc-number"]` to be visible.
- `readFinalTotalCents`: `parseInt(await page.locator('[data-total-cents]').first().getAttribute('data-total-cents'))`.
  Structured attribute, not prose — see §12.
- `confirmOutcome`: not needed; the store emits `[data-order-ref]`, which is exactly what
  `payWithCard` already looks for.

### 8.2 `genericAdapter` — best effort, allowed to give up

Matches everything (registered last).

- `toPaymentPage`: click the first visible element matching a small set of buy/checkout affordances
  (`a,button` with text matching `/buy now|checkout|proceed to (pay|checkout)/i`), up to two hops,
  waiting for `input[autocomplete="cc-number"]`. If the shipping profile is set, fill
  `autocomplete="name|email|street-address|postal-code|tel"` fields when present. If no card field
  appears, throw `PRECHECK_FAILED`.
- `readFinalTotalCents`: first `[data-total-cents]`, else the last currency-shaped match in an
  element whose text matches `/total/i`, parsed strictly to integer cents. Ambiguity throws
  `TOTAL_UNREADABLE` — the item is skipped rather than guessed at.
- `confirmOutcome`: looks for a confirmation heading (`/order (confirmed|placed)|thank you/i`) plus
  an order-number-shaped token, and returns that token. Returns null otherwise.

### 8.3 What a real merchant would additionally need

Recorded so nobody discovers it live: an authenticated session or true guest checkout; a shipping
address and contact details, which means a `ShippingProfile` in env; a billing address the card
will pass AVS with (**unknown today** — `CLAUDE.md` blocker 3); no 3DS on the card (**unknown
today** — blocker 2); a total that lands inside S$5–S$30 *after* shipping; and a confirmation page
we can read a reference from. Every one of those is a hard gate, and four of them are questions for
StraitsX, not engineering tasks.

---

## 9. Shopee: no

**An unattended agent cannot complete a Shopee purchase, and attempting one on the live rail risks
real money for a near-certain failure.** Four independent blockers, any one of which is fatal:

1. **Account login is mandatory.** No guest checkout. The login path presents a slider/puzzle
   captcha and device fingerprinting, and frequently an SMS OTP on a new device — which a headless
   browser in a demo booth is, every time.
2. **Bot detection is adversarial and active.** Shopee fingerprints the browser, and automation
   flags in Playwright are detectable. Stealth patching is an arms race; a patch that works in
   rehearsal can fail on stage, and the failure mode is a silent block partway through checkout.
3. **Checkout has its own OTP/3DS step.** Adding a new card typically triggers issuer verification.
   Our card is **single-use, ~10 minutes, and auto-destructs on first authorisation**. A 3DS
   challenge with nobody to answer it burns the card and the money for nothing. Whether the
   StraitsX card is even 3DS-enrolled is still an open question with StraitsX (`CLAUDE.md`).
4. **The amounts do not fit.** Cards mint between S$5 and S$30 with no splitting. Shopee totals
   move after address and shipping selection, frequently crossing S$30 on anything worth demoing.

Blocker 3 is the one that turns "it fails" into "it fails expensively", and it is why this is a
design decision rather than something to try on the day.

**Fallback ladder, in the order we should reach for it:**

1. **`apps/demo-store` on :4030 as the demo merchant**, labelled honestly as our own store. The
   whole money path — mandate, reservation, x402 settlement, real card, real autofill, real order —
   is genuine; only the shop is ours. This is the demo-safe default and it is what the plan builds.
2. **A small Singapore merchant with true guest checkout**, card fields on the page (no wallet
   redirect), no 3DS, and a basket that lands in band. Needs a manual end-to-end rehearsal with a
   real card *before* the demo, and needs StraitsX to confirm which merchants they have verified
   (blocker 4).
3. **If judges require a real purchase:** do exactly one rehearsed purchase at a verified merchant
   with a human standing by to answer any challenge, capture it on video, and run the on-stage
   demo against the demo store. One live card, one human, one attempt.

---

## 10. The S$30 ceiling versus the product's numbers

### 10.1 What cannot be bought

`BACKEND_CONTRACT.md` ships a S$429 GPU in its shortlist example and a S$600 `itemCap` in the
mandate. **Neither is purchasable on this rail.** `assertIssuable` refuses anything outside
S$5–S$30; `decide()` denies `ABOVE_RAIL_MAXIMUM` before that; and splitting one purchase across
several cards is explicitly not built (`CLAUDE.md`, "Not built"). A S$429 item is not a stretch —
it is fourteen times the ceiling.

### 10.2 What the demo should buy instead

Re-theme the demo activity to something whose line items are natively S$5–S$30. A worked example
that fits the six-item screen and the daily cap:

| Item | Tag | Price |
|---|---|---|
| USB-C hub | HUB | S$18.00 |
| 1TB NVMe SSD | SSD | S$29.00 |
| Braided USB-C cable | CBL | S$12.00 |
| Desk lamp | LMP | S$18.00 |

Total S$77.00, four cards, every one inside the band, comfortably under a S$150 daily cap. Two of
these already exist in `apps/demo-store`.

The UI should show item budgets in that range and a mandate slider ranged **5–30**, not 0–600.
Presenting a S$429 GPU that the backend must then refuse is a worse demo than presenting four
things it actually buys.

### 10.3 What `totalMinor` means

`totalMinor` is **money that left the wallet**: `purchased` plus `stranded`. It is not the sum of
delivered goods. If an item strands, the wallet really is lighter and the activity total must say
so, with a `SYS` line naming the stranded amount. `archiveLines` should list stranded items too,
marked as not delivered, so the total and the line items agree.

*Cost if wrong:* if the product prefers "total value of goods received", the two numbers diverge
from the wallet and the demo has to explain why the balance dropped further than the total. Chosen
deliberately: the wallet is the thing the judges can verify on-chain.

---

## 11. Where this design pushes back on things it must not change

### 11.1 `@happy/pay` change requests — written down, not made

The brief forbids modifying `packages/pay`. These are the cases, for the owner to judge:

1. **`payWithCard` detects success only via `[data-order-ref]`** (`checkout.ts:80`). That attribute
   exists on our demo store and essentially nowhere else. On a real merchant a *successful* order
   returns `{ok:false, error:'TIMEOUT'}`, and a caller that trusts it strands a purchase that
   actually went through. **Requested:** an optional caller-supplied confirmation strategy, e.g.
   `payWithCard(page, id, { orderRef: (page) => Promise<string|null> })`.
   **Workaround until then:** `adapter.confirmOutcome`, called only on `TIMEOUT` (§5, Z6). It
   recovers the goods without weakening invariant 8, because it must produce a real reference.
2. **`payWithCard` clicks the first `button[type="submit"]` on the page** (`checkout.ts:72`). On a
   real checkout that could be a coupon or newsletter form. **Requested:** an optional submit
   selector. No workaround exists in the Closer — once `payWithCard` is called, the click is its.
3. **No 3DS handling.** A challenge page reads as `TIMEOUT` and the card is burned. Not a
   library defect so much as a rail question (blocker 2), but the failure surfaces here.
4. `cancel` after issuance always strands. Correct, and no change wanted — noted so nobody reads
   `stranded` as a Closer bug.

### 11.2 `BACKEND_CONTRACT.md` mismatches — flag, do not paper over

| Contract says | Reality | What should happen |
|---|---|---|
| `"network": "Polygon"` | Avalanche — Fuji 43113 sandbox, C-Chain 43114 production | Fix the contract and the mock. The chain is the demo's whole point. |
| Mandate caps are whole SGD (`itemCap: 600`) | `@happy/pay` speaks integer cents and refuses > 3000 | API converts ×100 and clamps to `mandate.limits`; slider re-ranged 5–30 |
| S$429 GPU in the shortlist example | Unbuyable (§10) | Re-theme the demo data |
| No approval endpoint | `NEEDS_HUMAN` needs `approve(purchaseId)` | Either add `POST /v1/activities/:id/items/:itemId/approve`, or keep `perItemCents === maxCardCents` (D5) |
| `Wallet.balanceMinor`, `address` | `getWallet()` returns `null` for both in mock mode | API renders a mock placeholder; never invent a number |
| `Wallet.cards[].pan: "4319 •••• 4402"` | Only `last4` is available, ever | `"•••• •••• •••• 4402"` |

`buildWalletView()` — an optional Closer export that assembles the contract's `Wallet` from
`getWallet()`, `listPurchases()` and `getMandate()` — is specified here and sits **below the cut
line**. If the API author wants it, it is thirty lines; if they would rather own it, they should.

---

## 12. Prompt injection

`apps/demo-store` serves a deliberately hostile page (`/item/injected`) with an off-screen
instruction to buy gift cards for an attacker. The Closer's defence is structural, not textual:

- **Page text is never an instruction.** The Closer parses exactly two things out of a page: an
  integer from a structured total attribute, and (in the generic adapter's `confirmOutcome`) an
  order reference. No page content reaches a model prompt, because the Closer has no model in it.
- **The merchant host comes from `page.url()`**, so a page cannot redirect money to another host
  without an actual navigation, which changes the host we quote against.
- **Amounts pass the mandate anyway.** The injected page's S$50 gift cards are denied
  `ABOVE_RAIL_MAXIMUM`; the attacker host is denied `MERCHANT_NOT_ALLOWED`. `packages/pay`'s e2e
  test already asserts both.

The Closer's own test asserts that a run over `/item/injected` buys the S$18 desk lamp on that page
and nothing else, and that no purchase exists for any other host.

---

## 13. Testing

| Layer | What it covers | How |
|---|---|---|
| Ladder units | Every row of §5, including `PAYING` → abort | fake `PayApi`, fake page, no browser |
| Journal | duplicate key, in-flight key, new key on a finished activity, `issuing` poison | temp dir, real fs |
| Events | exact `exec.step`/`log.line` sequence and text for a clean item and a stranded one | recorded `onEvent` |
| Adapters | demo-store navigation and total parsing; generic give-up paths | real chromium, demo-store on an ephemeral port |
| End to end | real `@happy/pay` with `ISSUER=mock`, real browser, real store: two items purchased, mandate `spentCents` correct, no card material anywhere in the result | mirrors `packages/pay/test/e2e.test.ts` |
| Injection | hostile page cannot move money off-band or off-host | demo-store `/item/injected` |

Never against the live rail: `ISSUER=mock` everywhere, ports 4033/4034 (4030 is dev, 4032 is pay's
e2e). `pnpm test` from the root must stay green — 100 tests today, plus the Closer's.

---

## 14. Deliberately not built

Baskets and multi-card splitting (the rail cannot); refunds (do not exist); retry onto a second
card (would double-spend); parallel item execution (contract forbids, rail rate-limits); merchant
login and credential storage; a stealth/anti-detection layer; an HTTP server or SSE transport (the
API app owns them); alternate-listing fallback (the discovery agent and the shortlist UI own it);
`buildWalletView` (specified, below the cut line); on-chain mandate enforcement.

---

## 15. Open questions — these need a human

1. **Which merchant is the demo actually pointed at?** Everything above assumes `apps/demo-store`.
   A real merchant needs §8.3 satisfied and a rehearsal.
2. **Is the StraitsX card 3DS-enrolled?** (`CLAUDE.md` blocker 2.) If yes, every unattended
   checkout at a real merchant is a coin flip that costs a card when it loses.
3. **What billing address does the card carry?** (blocker 3.) Needed for AVS at any real merchant.
4. **Production whitelisting for the wallet** (blocker 1) — without it there is no real purchase.
5. **Does the product accept a S$5–S$30 demo?** §10.2 proposes re-theming. If the S$429 GPU must
   stay on screen, someone has to decide what the UI says when the backend refuses to buy it.
6. **Who owns `POST /v1/activities/:id/purchase`?** The Closer is a library and expects to be
   called; nobody has claimed the API side of the contract yet.
</content>
</invoke>
