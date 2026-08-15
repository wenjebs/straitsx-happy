# Backend contract

What the Happy frontend needs in order to run against a real backend instead of
its built-in mock.

Implement everything here and the frontend needs no changes: set
`VITE_API_BASE_URL` and it switches over.

The client side of this contract is [`src/lib/Api.ts`](src/lib/Api.ts). It is
the single place the UI talks to the network, and its TypeScript types are the
authoritative shapes. If you change one, change the other.

---

## 1. Switching the frontend on

```bash
# frontend/.env.local
VITE_API_BASE_URL=http://localhost:8787
```

Unset (or empty) means the in-browser mock in `src/lib/mockBackend.ts` runs
instead. There is no third mode and no partial mode: if the variable is set, the
frontend expects **every** endpoint below to exist.

The frontend never silently falls back to mock data when a configured backend is
unreachable. It shows a connection banner and keeps the last known state, because
quietly swapping simulated agent state in for real state would be misleading — and
on a rail that spends real money, dangerous.

### CORS

The browser calls the API cross-origin. Allow the frontend's origin
(`http://localhost:4040` in dev):

```
Access-Control-Allow-Origin: http://localhost:4040
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: content-type
```

`Access-Control-Allow-Origin: *` also works while there are no credentials.

### Auth

None today. `authHeaders()` in `Api.ts` is the single seam where it gets added.

If you add auth, note that **`EventSource` cannot send custom headers**, so a
`Authorization: Bearer` scheme will not work for the SSE stream. Use a cookie, or
accept a token as a query parameter on the events endpoint.

---

## 2. Conventions

**Money is minor units.** Every amount the frontend does arithmetic on is an
integer number of SGD cents, named `*Minor`. `amountMinor: 42900` is S$429.00.
Alongside it, send a preformatted `price` string for display. The frontend never
parses `price`, and never derives a total from it — totals are summed from
`amountMinor`. Mixing these up is the bug that ruins the demo (see the repo
root's `README.md` money-units section).

**Timestamps** are ISO 8601 (`createdAt`, `searchStartedAt`). Display-only
strings (`displayTs`, `ts` on log lines) are sent preformatted, because they are
human labels rather than instants — `"now"`, `"14:41"`, `"Aug 12"`, `"14:32:08"`.

**Item identity colour** is `hueIndex`, an integer `0-5`. The frontend owns the
actual palette; the backend just has to assign each item in an activity a stable
distinct index, in creation order. Six is the maximum before recycling.

**Stage vocabulary is shared verbatim.** No translation layer, in either
direction, because a translation layer is where the two sides drift apart.

```
ActivityStage : "idle" | "wishlist" | "curate" | "search" | "shortlist" | "exec"
ActivityStatus: "draft" | "live" | "completed" | "cancelled"
StageIndex    : 0 | 1 | 2 | 3 | 4      // Discovering, Analyzing, Gathering, Comparing, Selected
```

**Errors**: any non-2xx is surfaced to the user as a banner. Send a plain-text or
JSON body with a human-readable message; the frontend shows the body verbatim,
so write it for a person.

---

## 3. Core object

Every activity endpoint returns this. Optional fields may be omitted.

```jsonc
{
  "id": "act_01H...",
  "title": "Budget gaming PC build",
  "stage": "search",
  "status": "live",
  "createdAt": "2026-08-15T14:30:00Z",
  "completedAt": "14:41",              // display string, set when completed
  "displayTs": "now",                  // feed card timestamp
  "totalMinor": 125300,

  "messages": [
    { "id": "m1", "role": "user", "text": "build me a budget gaming PC under S$1,600" },
    { "id": "m2", "role": "assistant", "text": "", "card": "thinking",
      "thinkingLabel": "decomposing goal into a wishlist" },
    { "id": "m3", "role": "assistant", "text": "Six parts get you...", "card": "wishlist" },
    { "id": "m4", "role": "assistant", "text": "First, graphics card...",
      "card": "curator", "itemId": "gpu" },
    { "id": "m5", "role": "assistant", "text": "That is everything...", "card": "locked" }
  ],

  "wishlist": [
    { "id": "gpu", "name": "Graphics card", "short": "GPU",
      "spec": "RTX 4060 class, 8GB", "budget": "S$430", "hueIndex": 0 }
  ],
  "wishlistEstimate": "est. S$1,285",

  "clarifications": [
    { "itemId": "gpu", "prompt": "",
      "chosen": "RTX 4060 8GB",
      "options": [
        { "name": "RTX 4060 8GB", "range": "S$399 – S$489",
          "why": "Best 1080p per dollar with DLSS 3 and low power draw.",
          "imgLabel": "gpu · 4060", "imageUrl": null }
      ] }
  ],

  "itemProgress": [
    { "itemId": "gpu", "stage": 2, "previousStage": 1, "queued": false }
  ],

  "agents": [
    { "agentId": "ag-1004", "itemId": "gpu", "slot": 0,
      "url": "bizgram.com.sg/rtx-4060", "stage": 2,
      "action": "pulling seller history", "queued": false,
      "liveStreamUrl": "https://agents.example/streams/ag-1004" }
  ],
  "searchPlaying": true,
  "searchStartedAt": "2026-08-15T14:33:10Z",

  "shortlist": [
    { "itemId": "gpu", "reSearched": false,
      "listing": {
        "title": "ASUS Dual RTX 4060 OC 8GB",
        "seller": "Bizgram Asia",
        "rating": "4.8 · 1,204 reviews",
        "price": "S$429.00",
        "amountMinor": 42900,
        "why": "Cheapest in-stock 4060 from a seller with a local RMA counter.",
        "imageUrl": null
      } }
  ],

  "execution": [
    { "itemId": "gpu", "step": 2, "state": "live",
      "action": "bizgram-asia/checkout · autofill ok",
      "liveStreamUrl": "https://closer.example/streams/attempt-1" }
  ],

  "log": [
    { "id": "l1", "ts": "14:32:08", "tag": "GPU", "hueIndex": 0,
      "text": "card 4319 4400 issued · limit S$429.00" }
  ],

  "archiveLines": null   // completed/cancelled activities only
}
```

### Field notes that matter

| Field | Why it matters |
|---|---|
| `itemProgress[].previousStage` | **The single most important field in this document.** See §5. |
| `itemProgress[].queued` | `true` before an item's agents are dispatched. Renders a hollow dashed dot and dims its tiles. |
| `agents[].slot` | `0` is the lead agent, `1` trails one stage behind. Send exactly two per item — the screen is built around twelve tiles for six items. |
| `agents[].action` | Free text, shown verbatim under the tile. Suggested: `crawling listing pages`, `reading spec table`, `pulling seller history`, `diffing 6 candidates`, `locked candidate`, `waiting for a slot`. |
| `agents[].liveStreamUrl` | Optional embeddable URL for the Scout's live browser viewport. The frontend renders it in a sandboxed iframe. Until supplied, the tile says it is waiting for the stream; there is no simulated page animation. The stream server must permit framing via its CSP / `X-Frame-Options` policy. |
| `execution[].step` | `0` queued, `1-3` in flight, `4` purchased. Drives a progress fill at `step/4`. |
| `execution[].action` | Optional current Closer status, shown above its livestream. |
| `execution[].liveStreamUrl` | Optional embeddable Closer browser stream. It is rendered on the execution screen and must permit framing. |
| `messages[].card` | Which in-chat card renders under the text. `thinking` \| `wishlist` \| `curator` \| `locked`. Omit for plain text. |
| `imageUrl` | Optional on listings and curator options. When present the frontend renders it in place of the striped placeholder, same box size and radius. |

---

## 4. Endpoints

All paths are relative to `VITE_API_BASE_URL`.

### Activities

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/v1/activities` | — | `Activity[]` |
| `GET` | `/v1/activities/:id` | — | `Activity` |
| `GET` | `/v1/activities/:id/checkpoints` | — | `ActivityCheckpoint[]` |
| `POST` | `/v1/activities` | `{ "goal": string }` | `Activity` |
| `POST` | `/v1/activities/:id/wishlist/items` | `{ "name": string }` | `Activity` |
| `DELETE` | `/v1/activities/:id/wishlist/items/:itemId` | — | `Activity` |
| `POST` | `/v1/activities/:id/wishlist/approve` | — | `Activity` |
| `POST` | `/v1/activities/:id/clarifications/:itemId` | `{ "option": string }` | `Activity` |
| `POST` | `/v1/activities/:id/dispatch` | — | `Activity` |
| `POST` | `/v1/activities/:id/search/pause` | — | `Activity` |
| `POST` | `/v1/activities/:id/search/resume` | — | `Activity` |
| `POST` | `/v1/activities/:id/shortlist/:itemId/reject` | — | `Activity` |
| `POST` | `/v1/activities/:id/purchase` | `{ "idempotencyKey": string }` | `Activity` |
| `GET` | `/v1/activities/:id/events` | — | `text/event-stream` (§5) |

`GET /v1/activities` drives the activity feed. Return the running activity (if
any) with `status: "live"`, plus completed and cancelled ones. **At most one
activity may be `live`** — the frontend picks the first one it finds and treats
it as the running activity.

`POST /v1/activities` creates from a free-text goal and should return with
`stage: "wishlist"` and the two opening messages already present (the user's
goal, and an assistant message with `card: "thinking"`). Emit a snapshot over
SSE when the real wishlist replaces the thinking state.

The backend persists each transition as both the current activity document and an immutable full
checkpoint. In particular, `wishlist.prepared` must commit before approval. The approval endpoint
reloads that stored document and advances it to curation; it does not reuse an in-process planner
result.

`POST .../clarifications/:itemId` locks one option. When the last ambiguous item
is resolved, append the assistant message with `card: "locked"` — that is what
renders the locked-items panel and the "Dispatch agents" button.

Archived activities (`status` `completed` or `cancelled`) need only
`id`, `title`, `status`, `displayTs`, `totalMinor` and `archiveLines`.

### Wallet, mandate, settings, profile

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/v1/wallet` | — | `Wallet` |
| `POST` | `/v1/wallet/topup` | `{ "amountMinor": number }` | `Wallet` |
| `GET` | `/v1/mandate` | — | `Mandate` |
| `PATCH` | `/v1/mandate` | `Partial<Mandate>` | `Mandate` |
| `GET` | `/v1/settings` | — | `Settings` |
| `PATCH` | `/v1/settings` | `Partial<Settings>` | `Settings` |
| `GET` | `/v1/profile` | — | `Profile` |

```jsonc
// Wallet
{
  "balanceMinor": 482050,
  "address": "0x8f…c14b",
  "network": "Polygon",
  "cards": [
    { "pan": "4319 •••• 4402", "amount": "S$429.00", "status": "used" }
  ],
  "transactions": [
    { "id": "t1", "ts": "15 Aug · 14:33", "label": "Card authorisation · Bizgram Asia",
      "ref": "auth 4402", "amount": "−S$429.00", "debit": true }
  ],
  "receipt": "+500.00 XSGD received · tx 0x4c…9ae1 · 3 confirmations"
}
```

Card `status` follows the lifecycle `issued → viewed → used → expired`.

```jsonc
// Mandate — caps are whole SGD, matching the slider units, not minor
{
  "autoApprove": true,
  "itemCap": 600,
  "actCap": 2500,
  "categoryRules": { "Electronics": "allowed", "Apparel": "ask first", "Collectibles": "blocked" }
}

// Settings
{ "notify": true, "sandbox": true, "region": "Singapore · SGD", "dataRetention": "90 days" }

// Profile
{ "name": "Tricia Lim", "email": "tricia.lim@hey.sg", "initials": "TL",
  "memberSince": "tricia.lim@hey.sg · member since Mar 2026",
  "rows": [ { "k": "Name", "v": "Tricia Lim" } ] }
```

`actCap` feeds the wishlist card's cap line and the shortlist footer's headroom
calculation, so it is not decorative — changing it changes what the purchase
screens say.

---

## 5. The event stream

`GET /v1/activities/:id/events` → `text/event-stream`.

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no        # if behind nginx — buffering destroys the animation
```

Frame format: the SSE `event:` field is the type, `data:` is the JSON payload.
The payload is the event object **without** the `type` key.

```
event: item.progress
data: {"progress":{"itemId":"gpu","stage":0,"previousStage":2,"queued":false}}

```

### Events

| Event | Payload | Required |
|---|---|---|
| `activity.snapshot` | `{ "activity": Activity }` | **yes** |
| `item.progress` | `{ "progress": ItemProgress }` | **yes** |
| `agent.update` | `{ "agent": AgentState }` | **yes** |
| `exec.step` | `{ "row": ExecutionRow }` | **yes** |
| `log.line` | `{ "line": LogLine }` | **yes** |
| `activity.completed` | `{ "completedAt": string, "totalMinor": number }` | **yes** |
| `wallet.updated` | `{ "wallet": Wallet }` | **yes** |
| `activity.stage` | `{ "stage": ActivityStage }` | optional |
| `message.appended` | `{ "message": Message }` | optional |
| `shortlist.ready` | `{ "shortlist": ShortlistPick[] }` | optional |

**Send `activity.snapshot` first, on every connect and every reconnect.** The
browser reconnects `EventSource` automatically; without a fresh snapshot the UI
resumes animating from a stale position.

Use `activity.snapshot` for structural changes (a message appended, a stage
change, the wishlist edited, the shortlist arriving). Use the granular events for
anything that moves. Optional events are accepted if you prefer finer grain, but
a snapshot is always sufficient.

### The one rule that the signature screen depends on

The multi-agent search screen animates each item's dot along a five-stop track.
**Forward and backward movement look deliberately different**, because an agent
looping from Gathering back to Discovering — going to check another candidate
listing before it has enough to compare — has to read as a decision, not a
glitch:

- forward → `850ms` ease-out, no glow
- backward → `1450ms` with anticipation and overshoot, plus a soft glow ring

The frontend decides which to use from `stage < previousStage`. So:

1. **Always send `previousStage`.** When an item has not moved, set it equal to
   `stage`. If you always send `previousStage === stage`, backward motion never
   renders and the screen loses the thing it exists to show.
2. **Emit one `item.progress` at the moment the agent actually moves.** Do not
   batch several items' moves into one frame on a timer. The client animates each
   event as it arrives; batching collapses the motion.
3. **Do not send redundant `item.progress` events.** Re-sending an unchanged
   position re-triggers the transition and makes the dot stutter.

The same applies to `exec.step` and `log.line` during checkout: one event per
real step, when it happens.

---

## 6. Purchase, and the real rail

`POST /v1/activities/:id/purchase` is the only call that spends money. On the
live StraitsX rail it issues one single-use card per item, and **there are no
refunds**.

The frontend already does its part:

- the shortlist button opens an explicit confirmation naming the amount; it does
  not spend directly
- the call is submitted **once** and is **never retried automatically** — a retry
  would double-spend
- the button is disabled while the call is in flight
- nothing anywhere polls card status (the rail rate-limits after roughly 12
  POSTs, and that budget is shared)

What the backend must do:

- **Honour `idempotencyKey`.** If the same key arrives twice, return the existing
  execution rather than starting a second one. A refresh mid-flight or a
  duplicate submission must not buy twice.
- Check the mandate (`itemCap`, `actCap`, `categoryRules`) before issuing
  anything, and reject with a readable message if it fails.
- Issue cards at exactly the approved amount, so an agent cannot overspend a card
  it holds.
- Give Closer a short-lived, attempt-bound grant and issue the card only when
  Closer actively claims it. Do not create or push the card while queuing the job.
- Drive execution strictly sequentially: four steps per item, one item at a time,
  emitting `exec.step` and `log.line` as each actually happens.
- Treat the browser purchase as asynchronous: accept Closer callbacks, reject stale
  `attemptId`s, deduplicate `eventId`s, and debit only after `order.confirmed`.
- On completion emit `activity.completed` **and** `wallet.updated`, so the
  balance and the feed card update without a refetch.

Suggested log line forms, which the UI renders verbatim:

```
Closer claimed card 4400 · limit S$429.00
bizgram-asia/checkout · autofill ok
placing order S$429.00
order #SG830142 confirmed · card expired
```

---

## 7. A full run, in order

```
POST /v1/activities                    { goal }            -> stage: wishlist
  SSE activity.snapshot                                     (thinking -> wishlist card)
POST /v1/activities/:id/wishlist/approve                   -> stage: curate
  SSE activity.snapshot                                     (first curator card)
POST /v1/activities/:id/clarifications/gpu   { option }
  SSE activity.snapshot                                     (second curator card)
POST /v1/activities/:id/clarifications/case  { option }
  SSE activity.snapshot                                     (locked panel + dispatch)
POST /v1/activities/:id/dispatch                           -> stage: search
  SSE item.progress  x N   as each agent moves
  SSE agent.update   x N
  ...all items reach stage 4...
  SSE activity.snapshot                                     -> stage: shortlist
POST /v1/activities/:id/shortlist/gpu/reject               (optional)
POST /v1/activities/:id/purchase       { idempotencyKey }  -> stage: exec
  SSE exec.step + log.line   x (items * 4)
  SSE activity.completed
  SSE wallet.updated
```

---

## 8. Checking it works

With the backend running:

```bash
curl -s $VITE_API_BASE_URL/v1/activities | jq
curl -N $VITE_API_BASE_URL/v1/activities/<id>/events
```

The stream should print `event: activity.snapshot` immediately on connect, then
`item.progress` frames as agents move.

Then start the frontend with the variable set and walk the flow. Signs it is
wired correctly:

- the activity feed lists your activities, not the mock's five
- the search screen's dots move as your agents move
- at least one item loops backward with the slower overshoot and a glow ring
- the connection banner is absent (it appears only while connecting or on error)
