# Happy — an agent wallet with a real spending limit

The money half of an AgentiX Playground build. A user keeps XSGD (digital
Singapore dollars) in a wallet only they control, and sets one spending rule:
*up to S$25 per item, S$150 a day, these merchants, until tomorrow night*. When
an AI agent wants to buy something, we check the purchase against that rule,
move exactly the right amount, and mint a **single-use Visa card for exactly
that amount**. The agent types the card into the shop's checkout. The card dies
after one use.

The agent never holds the user's key, and never holds more than one purchase
worth of money.

Full design: [`DESIGN.md`](./DESIGN.md). Plain-English version: [`PLAIN.md`](./PLAIN.md).

## Layout

```
apps/
  api/            mandate-svc :8787   mandates, decide(), ledger, purchases
                  + card-svc (x402 client, issuer adapter)
                  + wallet-svc (Kernel account, session-key userOps)
                  + recon-svc (settlement poller)
  web/            :5173   Vite + React + wagmi. Mandate builder, balance, feed.
  mock-issuer/    :4020   Lithic-shaped local issuer. Real Luhn PANs, offline.
  demo-store/     :4030   Storefront + order webhook.
packages/
  shared/         zod wire schemas, chain constants, money-unit converters
aa-probe/         throwaway ERC-4337 spikes (verified on Fuji)
```

Everything in `apps/` deploys independently. `packages/shared` exists so the
API and the web app can't disagree about the wire format.

## Running it

```bash
pnpm install
cp .env.example .env        # defaults are mock-issuer, zero external deps
pnpm dev                    # all four apps
```

Or one at a time: `pnpm dev:api`, `pnpm dev:web`.

`ISSUER=mock` is the default and is the whole point — the full flow (rules,
ledger, card, checkout, activity feed) runs end to end on your laptop, offline,
unlimited times, for free. Flip `ISSUER=straitsx` only when you mean it: **there
are no refunds on this rail.**

```bash
pnpm test          # includes the unit-conversion guard below
pnpm typecheck
pnpm lint
```

## Three units, one bug

| Unit | Where | S$18.00 |
|---|---|---|
| `amount_sgd` | StraitsX API only | `18` |
| `minor` | our ledger + AP2 | `1800` |
| `atomic` | EIP-712 signing, XSGD 6dp | `18000000` |

Never compute `atomic` yourself — take it from the x402 challenge and run
`assertAtomicMatchesMinor` from `@happy/shared`. A silent 1e4 slip approves
10,000× the intended spend. There are tests for this; keep them passing.

## Two rules for dependencies

- **`viem` is pinned to `2.55.11`** across every package. Don't float it.
- **Never install `x402`, `x402-fetch`, `x402-axios`, `@x402/*`, or
  `@agentic-card/protocol`.** StraitsX's payment envelope differs from the
  reference implementation, and those libraries produce a format it silently
  rejects. The hand-rolled client in `apps/api` is the verified one.

## This repo is public

No keys in commits. `.env` is gitignored; `.env.example` is the only committed
config. The private keys in `aa-probe/` are the well-known anvil test key and a
throwaway Fuji session key — worthless, and deliberately so.
