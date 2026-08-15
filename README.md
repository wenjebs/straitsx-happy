# happy

Spending limits for AI agents. An agent gets a single-use Visa card worth exactly
one purchase, minted at checkout time from a user's XSGD, and only if the purchase
passes a spending rule the user set in advance.

Two things enforce the rule: the service checks every purchase against it, and
the card is minted at the exact amount approved, so the agent cannot overspend a
card it holds. Enforcing the cap on-chain as well, via a smart account whose
session key the network itself constrains, is deferred — see the spec's
out-of-scope section.

Built for the AgentiX Playground. The concierge backend is integration-ready for
real Scout/browser agents and real StraitsX/Closer transactions. It deliberately
does not pretend a purchase succeeded when either external API is unconfigured.

- Design: [`DESIGN.md`](./DESIGN.md)
- Non-technical walkthrough: [`PLAIN.md`](./PLAIN.md)

## Quickstart

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Requires Node >= 22 and pnpm 11.

That starts two processes:

| | port | |
|---|---|---|
| `@happy/backend` | 8787 | activities, DynamoDB repository, SSE, agent callbacks, mandate and checkout orchestration |
| `@happy/frontend` | 4040 | React concierge UI |

Check it came up:

```bash
curl localhost:8787/v1/health
# blockers names whichever real external APIs still need configuration
```

`blockers` is non-empty when `decide()` will refuse, and says why.

## Scripts

| | |
|---|---|
| `pnpm dev` | backend and frontend together |
| `pnpm dev:backend` | just the backend |
| `pnpm dev:frontend` | just the frontend |
| `pnpm test` | vitest, all packages |
| `pnpm typecheck` | tsc across the workspace |
| `pnpm lint` / `pnpm format` | biome |

## Layout

```
backend/          :8787  Hono + DynamoDB + SSE + real-service adapters
frontend/         :4040  Vite + React, the Happy concierge UI
terraform/               ECS/Fargate + ALB + CloudFront + S3 + DynamoDB
packages/
  shared/                wire schemas, chain constants, money units
apps/                    legacy prototypes; not used by the current runtime
```

`backend/` implements the complete frontend contract and owns the safety
decision. It stores production state in DynamoDB, sends jobs to the separately
owned agent runtime, receives authenticated progress and livestream callbacks,
and drives checkout through an external payment/Closer adapter. See
[`backend/README.md`](./backend/README.md) for both integration protocols.

`frontend/` can still run with its in-browser mock when `VITE_API_BASE_URL` is
unset. When the variable is set, every screen uses the backend and never silently
falls back. Scout tiles embed `liveStreamUrl` from the real agent callback.

## Configuration

One `.env` at the repo root is read by the backend. Copy `.env.example`, then add
the external `AGENT_API_*`, `AGENT_CALLBACK_TOKEN`, and `PAYMENT_API_*` values
when the owning teams provide them. Until then, read-only screens work and the
health endpoint reports blockers; real workflow mutations fail clearly rather
than substituting simulated agents or payments.

Production sets `DATA_STORE=dynamodb`; local development defaults to memory.
The full AWS deployment and two-pass image bootstrap are in
[`terraform/README.md`](./terraform/README.md). **There are no refunds on the
live rail.**

## Money units

Three representations of the same amount. Mixing them up is the bug that ruins
the demo.

| unit | used by | S$18.50 |
|---|---|---|
| `amount_sgd` | StraitsX API | `18.5` |
| `minor` | our ledger, AP2 | `1850` |
| `atomic` | EIP-712 signing (XSGD is 6dp) | `18500000` |

Never derive `atomic` yourself. Take it from the x402 challenge and check it:

```ts
import { assertAtomicMatchesMinor } from "@happy/shared";

assertAtomicMatchesMinor(entry.amount, reservation.minor); // throws, doesn't return false
```

A silent factor-of-10,000 slip approves 10,000x the intended spend, which is why
this throws instead of returning a boolean. `packages/shared/src/money.test.ts`
covers it in both directions. Keep those tests passing.

Cards are capped at S$5–S$30 by the rail; `amount_sgd: 31` returns HTTP 400.
Fractional amounts are exact, not floored, so cards can be cent-accurate.

## Constraints

**Never install `x402`, `x402-fetch`, `x402-axios`, `@x402/*`, or
`@agentic-card/protocol`.** StraitsX's payment envelope differs from the
reference implementation, and these produce a shape it silently rejects. The
hand-rolled client is the verified one.

**Never poll `card.straitsx.ai`.** No health checks, no status widgets, no retry
loops. The rail rate-limits after roughly 12 POSTs and that budget is shared
with every other team at the venue. UI that wants a rail indicator reads the
last observed status from our side.

**`viem` is pinned to `2.55.11`** in every package. Don't float it.

This machine enforces a 7-day pnpm `minimumReleaseAge` quarantine, so anything
published in the last week fails to install. Most dependencies use caret ranges
for that reason.

## Repository is public

No keys in commits. `.env` is gitignored and `.env.example` is the only
committed config. The private keys under `aa-probe/` are the well-known anvil
test key and a throwaway Fuji session key, deliberately worthless.
