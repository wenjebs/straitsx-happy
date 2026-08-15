# happy

Spending limits for AI agents. An agent gets a single-use Visa card worth exactly
one purchase, minted at checkout time from a user's XSGD, and only if the purchase
passes a rule the user signed.

Built for the AgentiX Playground. Runs entirely offline against a mock issuer by
default.

- Design: [`DESIGN.md`](./DESIGN.md)
- Non-technical walkthrough: [`PLAIN.md`](./PLAIN.md)

## Quickstart

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Requires Node >= 22 and pnpm 11.

That starts four processes:

| | port | |
|---|---|---|
| `@happy/api` | 8787 | mandates, `decide()`, ledger, card issuance |
| `@happy/web` | 5173 | mandate builder, balance, activity feed |
| `@happy/mock-issuer` | 4020 | local card issuer, real Luhn PANs |
| `@happy/demo-store` | 4030 | storefront the agent checks out against |

Check it came up:

```bash
curl localhost:8787/v1/health
# {"ok":true,"issuer":"mock","chainId":43113,"blockers":[]}
```

`blockers` is non-empty when `decide()` will refuse, and says why.

## Scripts

| | |
|---|---|
| `pnpm dev` | all four apps |
| `pnpm dev:api` / `pnpm dev:web` | one app |
| `pnpm test` | vitest, all packages |
| `pnpm typecheck` | tsc across the workspace |
| `pnpm lint` / `pnpm format` | biome |

## Layout

```
apps/
  api/            :8787  hono + zod + better-sqlite3 + viem
  web/            :5173  vite + react + wagmi
  mock-issuer/    :4020  hono
  demo-store/     :4030  hono
packages/
  shared/                wire schemas, chain constants, money units
aa-probe/                ERC-4337 spikes, verified on Fuji
```

Apps deploy independently. `packages/shared` exists so the API and the web app
can't disagree about the wire format.

## Configuration

One `.env` at the repo root, read by every service. Copy `.env.example` and go;
the defaults need no credentials and reach no external service.

`apps/api/src/env.ts` validates it at boot and exits with a per-field error
rather than failing later, mid-payment.

Three variables switch rails. Nothing else should differ between environments:

```
ISSUER=mock                    # mock | straitsx
CARD_API_BASE=...              # sandbox | production
ALLOWED_NETWORK=eip155:43113   # fuji | mainnet
```

`ISSUER=mock` runs the full flow — rules, ledger, card, checkout, activity feed —
on your laptop, unlimited times, for free. Set `ISSUER=straitsx` only when you
mean it. **There are no refunds on this rail.**

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
