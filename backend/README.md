# Happy backend

The Hono HTTP/SSE backend for `frontend/`. It owns the mandate and wallet, stores durable state
in DynamoDB in production, and orchestrates three deliberately separate integrations:

1. **Scout agent** — plans the wishlist, searches listings, and supplies search livestreams.
2. **StraitsX card provider** — issues an exact-value, single-use card capability.
3. **Closer purchase agent** — opens one approved listing, obtains the card through that
   short-lived capability, checks out, and reports milestones plus its livestream.

The backend never persists a PAN or card capability token. Purchases are sequential, callback
events are deduplicated, stale attempt callbacks are rejected, and a retry gets a newly issued
card. Wallet funds move only after `order.confirmed`.

## Run locally

```powershell
Copy-Item .env.example .env
$env:COREPACK_INTEGRITY_KEYS='0' # only needed by older Corepack builds
corepack pnpm install
corepack pnpm dev
```

The defaults use `memory` storage and `local` mode for all three providers. This is an explicit
failsafe walkthrough: it sends real callbacks, SSE frames, execution steps, and livestream URLs,
but every stream says `LOCAL FAILSAFE` and no browser or payment is real. Local card and Closer
operations refuse to run unless Settings has Sandbox enabled.

To connect the real services later:

```dotenv
AGENT_MODE=remote
AGENT_API_BASE_URL=https://scouts.example
AGENT_API_TOKEN=...
AGENT_CALLBACK_TOKEN=...

CARD_MODE=remote
CARD_API_BASE_URL=https://cards.example
CARD_API_TOKEN=...

PURCHASE_AGENT_MODE=remote
PURCHASE_AGENT_API_BASE_URL=https://closer.example
PURCHASE_AGENT_API_TOKEN=...
PURCHASE_CALLBACK_TOKEN=...
```

Set any mode to `disabled` to make its dependent mutation return a readable `503`.

## Scout API Happy calls

All requests are JSON `POST`s and include a callback `{ url, token }`.

| Path | Purpose |
|---|---|
| `/v1/runs/plan` | Decompose the goal into wishlist items and clarifications. |
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
| `POST /v1/cards` | Issue the exact listing amount after mandate checks. | `{ cardId, last4, agentAccess: { revealUrl, token, expiresAt? } }` |
| `POST /v1/wallet/topups` | Confirm an XSGD wallet top-up. | `{ transactionId, confirmations }` |

`agentAccess` must be short-lived and single-use. Happy passes it directly to Closer and does not
store the token.

## Closer API Happy calls

Happy sends `POST /v1/purchase-runs` with `activityId`, `attemptId`, the exact selected listing,
the item, sandbox flag, idempotency key, card metadata/capability, and a callback `{ url, token }`.
An accepted response only means the asynchronous job was queued.

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
| Activities by user/date | `gsi1pk=USER#<id>`, `gsi1sk=<createdAt>#<id>` |
| Purchase state-machine cursor | `pk=ACTIVITY#<id>`, `sk=PURCHASE` |
| Wallet/mandate/settings/profile | `pk=USER#<id>`, `sk=<type>` |
| Purchase/idempotency lock | `pk=PURCHASE#<activityId>`, `sk=LOCK` |

The conditional purchase lock makes a repeated key return the existing execution and prevents a
different key from starting another purchase.
