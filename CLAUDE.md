# straitsx-happy — context for a fresh agent

Hackathon build (StraitsX AgentiX Playground, SMU, 14–16 Aug 2026). An AI shopping agent buys
real items using a single-use virtual Visa card, funded by paying SGD stablecoin (XSGD) on
Avalanche over an HTTP-402 handshake.

**This repo is the money half.** A teammate builds the chat UI and the shopping agent in a
separate repo. Judged on: autonomy, a real purchase, reliability, task complexity, and whether
the repo runs when cloned.

## Layout

| Path | What |
|---|---|
| `packages/pay` | **The deliverable.** `@happy/pay` — spending rules, budget ledger, x402 card purchase, card entry, reconciliation. |
| `packages/shared` | Money units (`sgdToMinor`, `minorToAtomic`, `assertAtomicMatchesMinor`) — **bigint-only**, passing a `number` throws. |
| `apps/demo-store` | Local storefront for testing, plus a hostile product page for the prompt-injection demo. |
| `apps/api` | Health endpoint and the zod env schema. No domain logic — deliberately. |
| `aa-probe/` | Research scratch from an ERC-4337 spike. Keep; `DESIGN.md` cites it. |

Docs: `packages/pay/README.md` (API), `packages/pay/ARCHITECTURE.md` (diagrams), `DESIGN.md`
(rail research + evidence), `docs/superpowers/specs/` and `docs/superpowers/plans/` (how it was
built), `happy-product-spec.md` (Ranen's product draft — direction, not contract).

## Commands

```bash
pnpm test                 # 153 tests. Run from the repo root.
pnpm typecheck
pnpm dev                  # demo-store :4030, api :8787
pnpm format               # ⚠️ reformats unrelated files — revert what isn't yours before staging
```

`pnpm biome check --write .` does **not** work here (resolves to something else). Use `pnpm format`.

## The rail — facts, all verified by probing, not by reading docs

There is **no public documentation** for this card API. `docs.straitsx.com` covers fiat and
stablecoin only; searching its index for card/3DS/BIN/issuance returns just "Cards Sub-Wallet",
which is unrelated. Everything below was established empirically. Trust it over any doc page.

| Fact | Value |
|---|---|
| Card bounds | **S$5–S$30**. `amount_sgd:4` → HTTP 400, `5` → 402, `30` → 402, `31` → 400 |
| Fractional amounts | Accepted, not floored. `18.5` echoes `"18500000"` |
| Fuji XSGD | `0xd769410dc8772695a7f55a304d2125320a65c2a5` · 6dp · chain 43113 |
| Mainnet XSGD | `0xb2f85b7ab3c2b6f62df06de6ae7d09c010a5096e` · chain 43114 |
| `payTo` | Read from **every** challenge — it rotates between events. Never hardcode. |
| Paid envelope | `{ x402Version: 2, accepted: <entry verbatim>, payload: { signature, authorization } }` — `accepted` **singular**. The array form and the v1 Coinbase form are both rejected. |
| Header | `PAYMENT-SIGNATURE`. Challenge arrives in `Payment-Required` — **title case**, look it up case-insensitively. |
| EIP-712 domain | From the challenge's `extra` only. `version()` and `DOMAIN_SEPARATOR()` revert on-chain. |
| Error bodies | 400 and 429 return **plain text**, not JSON. Check status before parsing. |
| Rate limit | HTTP 429 after ~12 POSTs, **shared with every team**. Never poll. |
| Gas | The facilitator pays. An agent wallet needs no AVAX. |
| Card TTL | ~10 min, single-use, auto-destructs on first authorisation. |
| Card view | One-time. A second fetch of `iframe_url` returns `"token used"`. `view_card_*` mints a fresh one — needs **both** `card_opaque_id` and `settlement_tx`. |
| **PAN is readable** | The response HTML contains the number, but split across elements. Strip non-digits first, then match. A naive regex finds nothing. **No vision model needed.** |
| Sandbox cards | **Cannot spend at a real merchant.** Only production cards can. |

MCP endpoints — the landing page advertises `https://card.straitsx.ai/mcp`, which **404s**:

```
https://card.straitsx.ai/sandbox/mcp      (streamable HTTP)   https://card.straitsx.ai/sandbox/sse
https://card.straitsx.ai/production/mcp                       https://card.straitsx.ai/production/sse
POST https://card.straitsx.ai/{sandbox,production}/cardapi/issue_card
```

Tools are `get_card_sandbox` / `get_card_prod` taking `amount_sgd` — **not** `get_virtual_card`
with `amount_usd` as the page claims. The MCP server is discovery only; it returns instructions
telling you to call `cardapi` directly, which is what this library does.

**Never send a paid POST from a wallet without funds** — an unfunded settlement burns StraitsX's
relayer gas. Unpaid 402 probes are free and safe.

## Money-safety invariants — do not break these

Each was a real bug caught in review. Breaking one costs unrecoverable money.

1. **Write before send.** The real nonce and exact envelope bytes are committed, and the purchase
   set to `PAYING`, *before* anything is transmitted. Reconciliation identifies the payment
   on-chain by that nonce and recovers a lost response by replaying those bytes.
2. **`prepare()` and `send()` stay separate.** Merging them reintroduces double payment: a retry
   that signs a fresh nonce can settle alongside the first.
3. **Retry only by replaying the stored envelope.** Never a new nonce.
4. **`PAYING` is untouchable.** Cancel and the reservation sweep both refuse it — nobody knows
   yet whether the money left.
5. **Spend is recognised at issuance, not completion.** Prepaid rail: minting *is* the spend.
6. **`NEEDS_HUMAN` is a gate at issuance**, checked against the *final* total. A merchant nudging
   the price ~2% past the cap otherwise buys a card with nobody asked.
7. **Cancelling a finished purchase throws.** Writing `RELEASED` over spent money erases it from
   the mandate and the cap re-authorises it.
8. **Unknown checkout outcome is a failure**, never `ok: true`. Money has already moved.
9. **No refunds exist.** Money spent with nothing bought is `STRANDED` and stays counted as spent.
10. **Card material never leaves the library** — not in logs, the audit trail, return values, or
    anywhere a model prompt could reach. This governs code paths, not pixels: a remote browser's
    live view shows the number as it is typed, so never mint one during card entry.
11. **Never require a top-level navigation after submit.** A gateway's 3DS challenge is a modal
    iframe on the same page; demanding navigation turns every challenge into a timeout, a
    cancelled purchase and a stranded card.
12. **Type card digits, do not `fill()` them.** Instant entry with no keystrokes is a named fraud
    signal, and the challenge it invites kills a single-use card.

## Environment

Single root `.env` (gitignored), `.env.example` committed. `ISSUER=mock` is the default and needs
nothing — the whole flow runs offline. `ISSUER=straitsx` + `SPEND_PRIVATE_KEY` spends real value.

Chain choice is what makes money fake or real: 43113 + sandbox cardapi = testnet, 43114 +
production cardapi = **real money**.

`card-responses/*.json` holds live card data (mode 0600, gitignored). Delete after use.

## State as of 15 Aug

- `main` pushed, 153 tests green, single branch.
- Payment flow **proven twice on the real sandbox rail**: settled on Fuji, card read, checkout
  completed. Txs `0xa47087a6…`, `0x48cde727…`.
- Wallet `0xB6A5caA6b11109fd25d856a5a8299eE8f3DB0f2e` — Fuji 20 XSGD left, mainnet 30 untouched.
- Not built (deliberate): baskets, refunds, splitting above S$30, HTTP wrapper, on-chain mandate
  enforcement, KMS signing, multi-user.

**Blocked on StraitsX, chase before building anything else:**
1. Production whitelisting for that wallet — without it there is no real purchase to demo.
2. Is the card 3DS-enrolled? An OTP challenge burns a single-use card with no human to answer.
3. What billing address does it carry, for address verification?
4. Which merchants have they verified end to end?

## Working style here

Weekend hackathon, not a maintained library. **Get the shortest working path running first.**
No scalability, no extensibility, no abstraction for a second case that will never arrive. A
demo that runs beats a design you can defend.

Only money-path defects justify a fix round — double payment, lost payments, spending past the
mandate, leaked card material, or reporting an order that never charged. Coverage gaps, test
ergonomics, style and architecture debates get logged and skipped.

If you have written two design documents and no code, you are doing it wrong.

**Everyone commits straight to `main` with plain `git commit`.** No branches, no Graphite, no
stacked PRs — several people work in this repo at once and the ceremony costs more than it
returns over a weekend. Stage only what you touched, commit often, pull before you push.

Do not run a blanket `git checkout -- .` while other agents are working; it discards their
uncommitted work. Revert named files instead.

This machine quarantines packages published in the last ~7 days. If an install is rejected for
its publish date, widen the range rather than pinning.
