# Happy backend

The Hono HTTP/SSE backend for `frontend/`. It owns the mandate and wallet, stores durable state
in DynamoDB in production, and orchestrates four deliberately separate capabilities:

1. **Happy OpenAI planner** — turns chat goals into typed wishlists and clarification questions.
2. **Scout agent** — searches approved wishlist items and supplies search livestreams.
3. **StraitsX card provider** — issues an exact-value card only when Closer claims its grant.
4. **Closer purchase agent** — receives one approved listing and a short-lived grant, actively
   claims the card, checks out, and reports milestones plus its livestream.

The backend never persists a PAN, raw card grant, or card capability token. Purchases are
sequential, callback events are deduplicated, stale attempt callbacks are rejected, and a retry
gets a new grant. Wallet funds move only after `order.confirmed`.

## Run locally

```powershell
Copy-Item .env.example .env
$env:COREPACK_INTEGRITY_KEYS='0' # only needed by older Corepack builds
corepack pnpm install
corepack pnpm dev
```

The defaults use `memory` storage and local planner/Scout/card/Closer failsafes. This is an explicit
failsafe walkthrough: it sends real callbacks, SSE frames, execution steps, and livestream URLs,
but every stream says `LOCAL FAILSAFE` and no browser or payment is real. Local card and Closer
operations refuse to run unless Settings has Sandbox enabled.

To connect the real services later:

```dotenv
PLANNER_MODE=openai
OPENAI_API_KEY=replace-with-a-fresh-key
OPENAI_MODEL=gpt-5.6-luna
AGENT_CALLBACK_TOKEN=replace-with-a-long-random-value

SCOUT_MODE=remote
AGENT_API_BASE_URL=https://scouts.example
AGENT_API_TOKEN=...

CARD_MODE=remote
CARD_API_BASE_URL=https://cards.example
CARD_API_TOKEN=...

PURCHASE_AGENT_MODE=remote
PURCHASE_AGENT_API_BASE_URL=https://closer.example
PURCHASE_AGENT_API_TOKEN=...
PURCHASE_CALLBACK_TOKEN=...
```

Set any mode to `disabled` to make its dependent mutation return a readable `503`.

## Happy OpenAI planner

Happy calls `POST /v1/responses` with `store: false` and a strict JSON Schema. The result contains
the title, assistant reply, editable wishlist, estimate, and clarification options. Happy assigns
stable item ids, validates the response again with Zod, and commits `wishlist.prepared` before the
user can approve it. The API key is server-only and must be supplied through the environment or
AWS Secrets Manager.

## Scout API Happy calls

All requests are JSON `POST`s and include a callback `{ url, token }`.

| Path | Purpose |
|---|---|
| `/v1/runs/search` | Start two Scouts per item and find candidate listings. |
| `/v1/runs/:activityId/pause` | Pause browser sessions. |
| `/v1/runs/:activityId/resume` | Resume browser sessions. |
| `/v1/runs/:activityId/reject` | Replace a rejected pick. |

The callback is `POST /v1/integrations/agents/:activityId/events`. Accepted events are
`wishlist.ready`, `item.progress`, `agent.update`, `shortlist.ready`, `message.appended`, and
`run.failed`. Payload schemas are in [`src/schemas.ts`](./src/schemas.ts).

## StraitsX card API Happy calls

| Path | Request purpose | Required response |
|---|---|---|
| `POST /v1/cards` | Issue the exact listing amount when Closer claims an approved grant. | `{ cardId, last4, agentAccess: { revealUrl, token, expiresAt? } }` |
| `POST /v1/wallet/topups` | Confirm an XSGD wallet top-up. | `{ transactionId, confirmations }` |

`agentAccess` must be short-lived and single-use. Happy returns it only in the response to
Closer's card-claim request and does not store the token.

## Closer API Happy calls

Happy sends `POST /v1/purchase-runs` with `activityId`, `attemptId`, the exact selected listing,
the item, sandbox flag, idempotency key, a `cardGrant`, and a callback `{ url, token }`. An
accepted response only means the asynchronous job was queued. No card has been issued yet.

Closer takes the card itself by calling `POST cardGrant.claimUrl` with
`Authorization: Bearer <cardGrant.token>`. The grant is bound to the attempt, item, listing amount,
mandate, and expiry. Happy then calls StraitsX and returns `{ cardId, last4, agentAccess }` directly
to Closer. The raw grant is never stored; only its SHA-256 hash is durable.

Closer posts one event at a time to
`POST /v1/integrations/purchases/:activityId/events`:

| Event | Extra fields | Meaning |
|---|---|---|
| `browser.started` | `liveStreamUrl`, `message?` | Listing is open; frontend embeds the stream. |
| `checkout.prepared` | `message?` | Cart and payment fields are ready. |
| `order.placing` | `message?` | Final merchant submission began. |
| `order.confirmed` | `orderId`, `message?` | Merchant confirmed; Happy records the debit. |
| `purchase.failed` | `message`, `retryable` | Happy expires the card and safely retries/falls back. |

Every event also includes unique `eventId`, current `attemptId`, and `itemId`. The callback token
is sent as `Authorization: Bearer <token>` or `x-happy-callback-token`.

## DynamoDB access patterns

Production uses one table:

| Entity/access | Keys |
|---|---|
| Activity by id | `pk=ACTIVITY#<id>`, `sk=META` |
| Immutable transition history | `pk=ACTIVITY#<id>`, `sk=CHECKPOINT#<time>#<id>` |
| Activities by user/date | `gsi1pk=USER#<id>`, `gsi1sk=<createdAt>#<id>` |
| Purchase state-machine cursor | `pk=ACTIVITY#<id>`, `sk=PURCHASE` |
| Wallet/mandate/settings/profile | `pk=USER#<id>`, `sk=<type>` |
| Purchase/idempotency lock | `pk=PURCHASE#<activityId>`, `sk=LOCK` |

Every `putActivity` atomically writes the latest `META` document and a full immutable checkpoint.
`GET /v1/activities/:id/checkpoints` returns those transitions in order. The conditional purchase
lock makes a repeated key return the existing execution and prevents a different key from starting
another purchase.
