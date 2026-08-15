# Happy backend

The Hono HTTP/SSE backend for `frontend/`. It owns the mandate and wallet, stores durable state
in DynamoDB in production, and orchestrates four deliberately separate capabilities:

1. **Happy OpenAI planner** — turns chat goals into typed wishlists and clarification questions.
2. **Scout agent** — searches approved wishlist items and supplies search livestreams.
3. **StraitsX card provider** — issues an exact-value card only when Closer claims its grant.
4. **Closer purchase agent** — receives one approved listing and a short-lived grant, actively
   claims the card, checks out, and reports milestones plus its livestream.
5. **XSGD funding verifier** — verifies inbound XSGD transfers on Avalanche and atomically credits
   the corresponding user's durable Happy ledger.

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

## Account authentication

Local development uses backend-issued email/password sessions and requires a separate random
server secret:

```dotenv
AUTH_MODE=local
AUTH_SESSION_SECRET=replace-with-a-random-32-character-secret
```

Create an account from the frontend login page. Local users live in process memory, while their
signed seven-day session survives a normal page refresh. AWS deployments set `AUTH_MODE=cognito`;
Terraform creates the Cognito User Pool and web client and passes their IDs to ECS. Cognito users
confirm their email before signing in, and the frontend refreshes expired ID tokens without
putting a Cognito secret in the browser.

All browser API routes except health and signup/login/confirmation require `Authorization: Bearer
<account-token>`. Activities, immutable checkpoints, wallet ledger, deposits, mandate and settings
are keyed by the authenticated account. Scout/Closer callbacks retain their separate service
tokens.

## Shared-wallet XSGD funding

Funding is deliberately separate from card issuance. The browser asks the user's injected EVM
wallet to call XSGD `transfer(HAPPY_WALLET_ADDRESS, amount)`; the backend never receives the
user's key. After submission, the backend reads the configured Avalanche RPC and credits the
account only when the receipt is successful and contains exactly one XSGD `Transfer` from the
connected address to Happy's configured shared wallet. The transaction hash is a global
idempotency key, so it cannot be credited twice.

Enable the real flow on Fuji with:

```dotenv
FUNDING_MODE=chain
HAPPY_WALLET_ADDRESS=0x...
CHAIN_ID=43113
RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
XSGD_ADDRESS=0xd769410dc8772695a7f55a304d2125320a65c2a5
XSGD_DECIMALS=6
FUNDING_NETWORK_NAME=Avalanche Fuji C-Chain
FUNDING_EXPLORER_URL=https://subnets-test.avax.network/c-chain
DEPOSIT_CONFIRMATIONS=1
WALLET_AUTH_SECRET=replace-with-a-random-32-character-secret
```

`HAPPY_WALLET_ADDRESS` is public and must match the shared wallet that Stage 2 will use to sign
card payments. `SPEND_PRIVATE_KEY` is not read by the funding provider. For production use chain
43114, the production XSGD address, the mainnet RPC/explorer, and an operational confirmation
policy. A confirmed deposit is custodial: Happy controls the XSGD after the transfer.
Before funding, the browser signs a five-minute ownership challenge that explicitly grants no
spending permission. Happy exchanges it for a 24-hour HMAC-protected wallet session bound to the
logged-in Happy account. The account token remains in `Authorization`; the wallet proof is sent in
`X-Happy-Wallet-Session`. This prevents a valid wallet proof from crediting a different account.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/wallet/auth/challenge` | Create a wallet-ownership message to sign. |
| `POST` | `/v1/wallet/auth/verify` | Verify the signature and return a funding session. |
| `GET` | `/v1/wallet/funding` | Shared-wallet/network configuration and deposit history. |
| `POST` | `/v1/wallet/deposits` | Register `{ txHash, sourceAddress }` and verify it. |
| `GET` | `/v1/wallet/deposits/:txHash` | Refresh a pending deposit's confirmations. |

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

`agentAccess` must be short-lived and single-use. Happy returns it only in the response to
Closer's card-claim request and does not store the token.

## Closer API Happy calls

Happy sends `POST /v1/purchase-runs` with `activityId`, `attemptId`, the exact selected listing,
the item, a provider-derived local-failsafe flag, idempotency key, a `cardGrant`, and a callback
`{ url, token }`. This flag is not a user setting. An
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
| XSGD deposit by transaction hash | `pk=DEPOSIT#<txHash>`, `sk=META` |
| Deposits by user/date | `gsi1pk=USER#<id>`, `gsi1sk=<createdAt>#<txHash>` |
| Purchase/idempotency lock | `pk=PURCHASE#<activityId>`, `sk=LOCK` |

Every `putActivity` atomically writes the latest `META` document and a full immutable checkpoint.
`GET /v1/activities/:id/checkpoints` returns those transitions in order. The conditional purchase
lock makes a repeated key return the existing execution and prevents a different key from starting
another purchase.
