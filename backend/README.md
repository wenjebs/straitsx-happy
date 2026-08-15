# Happy backend

The real HTTP/SSE backend for `frontend/`. It implements every route in
[`frontend/BACKEND_CONTRACT.md`](../frontend/BACKEND_CONTRACT.md), stores durable state in
Amazon DynamoDB in production, dispatches real work to an external agent runtime, and delegates
card reveal/merchant automation to a real payment/Closer service.

There is deliberately no fake purchase fallback. `/v1/health` reports
`AGENT_API_NOT_CONFIGURED` or `PAYMENT_API_NOT_CONFIGURED`, and affected mutations return a
readable `503`, until the corresponding API URL is configured.

## Run locally

```powershell
Copy-Item .env.example .env
# Add the agent/payment URLs and tokens when available.
$env:COREPACK_INTEGRITY_KEYS='0' # only needed by older Corepack builds
corepack pnpm install
corepack pnpm dev
```

The default `DATA_STORE=memory` is process-local development storage. To use DynamoDB Local or
AWS DynamoDB, set:

```dotenv
DATA_STORE=dynamodb
DYNAMODB_TABLE=happy-dev-data
AWS_REGION=ap-southeast-1
# Optional for DynamoDB Local only:
DYNAMODB_ENDPOINT=http://localhost:8000
```

## Agent API Happy calls

All calls are JSON `POST`s. If `AGENT_API_TOKEN` is set, Happy sends
`Authorization: Bearer <token>`.

| Path | Purpose |
|---|---|
| `/v1/runs/plan` | Decompose the goal into a wishlist and clarifications. |
| `/v1/runs/search` | Start two Scouts per item, five items concurrently. |
| `/v1/runs/:activityId/pause` | Pause browsers without losing the run. |
| `/v1/runs/:activityId/resume` | Resume browsers. |
| `/v1/runs/:activityId/reject` | Find a replacement for a rejected pick. |

The plan/search request contains a callback object:

```json
{
  "callback": {
    "url": "https://<happy-host>/v1/integrations/agents/<activityId>/events",
    "token": "shared-callback-token"
  }
}
```

The agent runtime posts one event at a time to that URL using either
`Authorization: Bearer <token>` or `x-happy-callback-token: <token>`. Accepted event types are:

- `wishlist.ready` — title, reply, editable wishlist, estimate, and 0–10 clarifications.
- `item.progress` — the item stage movement. Happy derives the trustworthy `previousStage` from
  persisted state and drops redundant movements.
- `agent.update` — Scout id/item/slot/stage/action/current URL and optional `liveStreamUrl`.
- `shortlist.ready` — one pick per item plus ranked `alternates` for safe fallback.
- `message.appended` — an additional user-visible agent message.
- `run.failed` — terminal human-readable failure.

Exact payload validation lives in [`src/schemas.ts`](./src/schemas.ts). A stream URL is rendered
inside a sandboxed iframe; its server must permit embedding through CSP `frame-ancestors` and must
not send an incompatible `X-Frame-Options` header.

## Payment/Closer API Happy calls

If `PAYMENT_API_TOKEN` is set, Happy sends it as a bearer token. The remote service must honor
every supplied idempotency key.

| Method/path | Required response | Actual milestone |
|---|---|---|
| `POST /v1/cards` | `{ "cardId": "...", "last4": "1234" }` | Exact-value card issued. |
| `POST /v1/checkouts` | `{ "checkoutId": "...", "merchant": "..." }` | Cart and payment details prepared. |
| `POST /v1/checkouts/:id/place` | `{ "orderId": "..." }` | Merchant confirmed the order. |
| `POST /v1/wallet/topups` | `{ "transactionId": "...", "confirmations": 3 }` | XSGD top-up confirmed. |

Happy never receives a full PAN. Before the first provider call it enforces the mandate, wallet
balance, category rules, and configured card rail band. It purchases strictly sequentially. An
alternate must be at or below the price the user confirmed; a higher-priced alternate is skipped.

## DynamoDB access patterns

Production uses one table:

| Entity/access | Keys |
|---|---|
| Activity by id | `pk=ACTIVITY#<id>`, `sk=META` |
| Activities by user/date | `gsi1pk=USER#<id>`, `gsi1sk=<createdAt>#<id>` |
| Wallet/mandate/settings/profile | `pk=USER#<id>`, `sk=<type>` |
| One purchase/idempotency lock | `pk=PURCHASE#<activityId>`, `sk=LOCK` |

The purchase lock is a conditional write. Repeating the same key returns the existing execution;
a different key cannot start another purchase.
