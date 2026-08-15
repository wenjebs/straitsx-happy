# Closer Purchase Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Closer an HTTP service that receives a listing and a one-use card grant from Happy, drives a real browser checkout, and reports progress back over callbacks.

**Architecture:** One new directory, `packages/closer/src/service/`, holding a dependency-free `node:http` server. Happy's protocol is already finished and is not modified. The browser arrives through the existing `BrowserLike` seam, so the same code runs on a local Chromium offline and on AgentCore against a real merchant.

**Tech Stack:** TypeScript, `node:http`, Playwright, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-closer-purchase-service-design.md`

## Global Constraints

- **Hackathon build.** Shortest working path. No abstraction for a second case that will not arrive. Tests cover the money path and nothing else.
- `ISSUER=mock` / `CARD_MODE=local` throughout. Spend nothing.
- Card material never reaches a callback, log, trace, screenshot, model prompt, or disk.
- Card digits typed with `pressSequentially`, never `fill()`.
- Never wait for a top-level navigation after submit.
- Unknown outcome ⇒ `purchase.failed`, never `order.confirmed`.
- One `idempotencyKey` claims a card at most once.
- Verification failure ⇒ report and stop. Never substitute a different item.
- `pnpm test` and `pnpm typecheck` stay green. `exactOptionalPropertyTypes` is on.
- Port **4042** for the service. 4030, 4033–4038, 4040, 4041 are taken.

## Files

| File | Responsibility |
|---|---|
| `service/jobs.ts` | Idempotency, cancellation, claim-once |
| `service/verify.ts` | The pre-card gate |
| `service/card.ts` | Claim and reveal |
| `service/callbacks.ts` | Progress events with stable ids |
| `service/liveview.ts` | Embeddable page, blankable |
| `service/run.ts` | The purchase itself |
| `service/server.ts` | Two endpoints + live view routes |
| `service/fill.ts` | Type the card into the gateway iframe |
| `backend/src/providers/stubListings.ts` | Five fixed listings |

---

### Task 1: Job store, verification, card claim/reveal

The three pure modules. One test file covers all three — they have no I/O between them and splitting the suite buys nothing here.

**Files:**
- Create: `packages/closer/src/service/jobs.ts`, `service/verify.ts`, `service/card.ts`
- Test: `packages/closer/test/service-core.test.ts`

**Interfaces produced:**
- `createJobStore(): JobStore` with `accept`, `get`, `setState`, `claimCardOnce`, `cancel`, `isCancelled`, `nextSeq`
- `verifyGrant(job: PurchaseJobInput, now?: Date): string | null`
- `verifyMerchantTotal(displayedMinor: number, approvedMinor: number): string | null`
- `type PurchaseJobInput` — the payload Happy sends
- `claimCard(grant, fetchImpl?): Promise<ClaimedCard>`, `revealCard(access, fetchImpl?): Promise<CardMaterial>`

- [ ] **Step 1: Write the failing tests** covering only what costs money if wrong:
  - `claimCardOnce` returns true exactly once per key
  - a repeat `accept` reports `created: false`
  - `cancel` marks an attempt, and cancelling a whole activity marks all its attempts
  - `verifyGrant` rejects: wrong currency, amount mismatch, expired grant, missing/non-http url
  - `verifyMerchantTotal` rejects one cent over, accepts equal and under
  - `claimCard` sends `Bearer <grant.token>` as POST; `revealCard` sends `Bearer <access.token>` as GET
  - a reveal missing the PAN throws rather than returning a partial card
  - neither error message contains the response body

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @happy/closer exec vitest run test/service-core.test.ts`

- [ ] **Step 3: Implement the three modules.** Key decisions, not negotiable:
  - `claimCardOnce` lives in the job store, not beside the fetch, so a reorder cannot skip it.
  - Error paths name the status and missing field *kinds*, never values — a claim or reveal body **is** the card.
  - `verifyGrant` runs on the payload only; the merchant total is separate because it needs a loaded page.

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Commit**

---

### Task 2: Callbacks and the live view

**Files:**
- Create: `packages/closer/src/service/callbacks.ts`, `service/liveview.ts`
- Test: `packages/closer/test/service-view.test.ts`

**Interfaces produced:**
- `eventIdFor(attemptId, type, seq): string` — a sha256 prefix, deterministic
- `sendCallback(target, base, event, opts?): Promise<boolean>` — bounded retry, never throws
- `type PurchaseEvent` — matches `PurchaseAgentCallbackEvent` in `backend/src/schemas.ts` exactly
- `createLiveView(): LiveView` with `page`, `attach`, `push`, `blank`, `resume`, `isBlanked`, `close`

- [ ] **Step 1: Write the failing tests:**
  - the same logical event derives the same id; different events derive different ids
  - a retry reuses the id and, after exhausting attempts, returns `false` rather than throwing
  - `push` reaches an attached subscriber
  - **a frame pushed while blanked never reaches a subscriber**, and resuming restores delivery
  - two attempts stay independent

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement.** Event ids are derived because Happy deduplicates on them — a random id shows the user the same step twice when our first POST times out. A callback that never lands is swallowed: the purchase already happened, and throwing would abort a run holding a live card.

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Commit**

---

### Task 3: The run

**Files:**
- Create: `packages/closer/src/service/run.ts`
- Test: `packages/closer/test/service-run.test.ts`

**Interfaces produced:**
- `type RunDeps = { jobs, view, browserFor, fetchImpl?, liveUrlFor, fillCard, readTotalMinor, submit }`
- `runPurchase(deps: RunDeps, job: PurchaseJobInput): Promise<void>`

Sequence: verify payload → open browser → `browser.started` → read the merchant's real total → check it → **claim once** → blank the view → reveal → type → `checkout.prepared` → `order.placing` → submit → resume the view → `order.confirmed` or `purchase.failed`.

- [ ] **Step 1: Write the failing tests** — the money path only:
  - the happy path emits exactly `browser.started`, `checkout.prepared`, `order.placing`, `order.confirmed`
  - a payload that fails verification never claims a card
  - a merchant total over the approved amount fails **without claiming**
  - a null order reference reports `purchase.failed`, never `order.confirmed`
  - the view is blanked while `fillCard` runs, and resumed afterwards
  - **no callback body contains the PAN or the CVC**
  - cancelling mid-run aborts before the claim

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement.** The ordering *is* the design: everything that can fail for free happens before the claim, because afterwards the card has ten minutes and dies on its first authorisation.

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Commit**

---

### Task 4: HTTP surface and real browser wiring

**Files:**
- Create: `packages/closer/src/service/server.ts`, `service/fill.ts`, `service/index.ts`, `service/start.ts`
- Modify: `packages/closer/package.json` (a `service` script), `.env.example`
- Test: `packages/closer/test/service-server.test.ts`

**Interfaces produced:**
- `createPurchaseServer({ token, jobs?, view?, startRun }): Server`
- `browserForEnv(): Promise<BrowserLike>` — `CLOSER_BROWSER=local|agentcore`
- `startPurchaseService(port?): Promise<Server>`
- `typeCardInto(page, card): Promise<void>`

- [ ] **Step 1: Write the failing tests:**
  - a missing or wrong bearer token gives 401 and starts nothing
  - a valid job gives **202** and starts exactly one run
  - a repeat idempotency key gives 202 and starts nothing new
  - a malformed body gives 400
  - cancel gives 200 even for an unknown attempt

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement.** 202 is sent *before* the run starts — Happy times out at 15s and treats a late answer as 502, which would strand a run we were about to begin. The live view routes sit outside the authenticated surface because an iframe cannot send a bearer token; they show pixels of an already-approved page and are blanked across card entry.

  `fill.ts` searches every frame, because PCI gateways render the number in an iframe they control and page-level locators do not cross frame boundaries.

  `submit` must not wait for a top-level navigation — a 3DS challenge is a modal iframe on the same page, and demanding navigation turns every challenge into a timeout and a stranded card.

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Commit**

---

### Task 5: End to end against demo-store

**Files:**
- Test: `packages/closer/test/service-e2e.test.ts`

- [ ] **Step 1: Write the test.** Stand up `apps/demo-store`, a fake Happy (claim, reveal, callback sink), and the service on a local browser. POST one job. Assert the callback sequence reaches `order.confirmed`, and that no callback body contains the PAN.

- [ ] **Step 2: Run it, and then the whole suite** — `pnpm test && pnpm typecheck`

- [ ] **Step 3: Commit**

---

### Task 6: Stubbed listings

**Files:**
- Create: `backend/src/providers/stubListings.ts`
- Test: `backend/src/stubListings.test.ts`

Five fixed listings across **Shopee and Lazada**, standing in for discovery.

**Measured reality, recorded rather than designed around** (see `docs/agentcore-browser.md`):

| Merchant | What happens from an AWS datacentre IP |
|---|---|
| **Lazada** | Intermittent slider captcha. **A human clears it in the live view and the run continues** — this is the takeover demo working. |
| **Shopee** | Hard bounce to `/verify/traffic/error`, `is_logged_in=false`. Nothing for a human to solve, so these listings will report `purchase.failed` at the first step. |

That is a real result, not a bug to hide: the Closer reports the bounce honestly rather than pretending. If a Shopee run is needed for the demo, the lever is `proxyConfiguration` on `StartBrowserSession`, which is untested.

- [ ] **Step 1: Write the failing test** — five listings, every URL https, every `amountMinor` within S$5–30 (the card's mint bounds), `price` consistent with `amountMinor`.

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement** with a comment stating what each merchant does, so the next person does not read a `purchase.failed` from Shopee as a code defect.

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Commit**

---

## Deliberately not built

Baskets. Retry after decline. Refunds. A durable job store — one process, one weekend. A merchant-specific total reader: Task 4 reads `[data-total-cents]`, which `apps/demo-store` provides and real merchants do not. Wiring the existing `MerchantAdapter.readFinalTotalCents` seam is the follow-up that makes a real-merchant run work, and it is not in this plan.

## Still blocked, and not by code

StraitsX production whitelisting for the wallet, and whether the card's BIN is 3DS-enrolled. With `CARD_MODE=local` the PAN is `4242…`, so a real merchant declines it — which exercises submit and decline handling, and is the most that can be tested before those answers arrive.
