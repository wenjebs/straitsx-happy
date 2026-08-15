# Closer Purchase Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Closer an HTTP service that receives a listing and a one-use card grant from Happy, drives a real browser checkout, and reports progress back over callbacks.

**Architecture:** One new directory, `packages/closer/src/service/`, holding a dependency-free `node:http` server. Happy's protocol is already finished and is not modified. The browser arrives through the existing `BrowserLike` seam, so the same code runs on a local Chromium offline and on AgentCore for the real merchant.

**Tech Stack:** TypeScript, `node:http` (no framework — the rest of `packages/closer` has no HTTP dependency and this needs three routes), Playwright, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-closer-purchase-service-design.md`

## Global Constraints

- `ISSUER=mock` and `CARD_MODE=local` for all development. Spend nothing.
- Card material — PAN, expiry, CVC — never reaches a callback, a log line, a trace, a screenshot, a model prompt, or disk. Locals only, only long enough to type.
- Card digits are typed with `pressSequentially`, never `fill()`.
- Never require a top-level navigation after submit.
- An unknown checkout outcome is `purchase.failed`, never `order.confirmed`.
- One `idempotencyKey` claims a card **at most once**.
- No substitution: if verification fails, report and stop. Never buy a different item.
- `pnpm test` and `pnpm typecheck` from the repo root stay green.
- The repo runs `exactOptionalPropertyTypes`; `{ x: undefined }` is not the same as omitting `x`.
- Ports 4030, 4033–4038, 4040, 4041 are taken. This service uses **4042**; its fake Happy in tests uses **4043**.
- Commit straight to the current branch with plain `git commit`. Stage only your own files.

---

### Task 1: Job store with idempotency and cancellation

**Files:**
- Create: `packages/closer/src/service/jobs.ts`
- Test: `packagesting/closer/test/service-jobs.test.ts` → `packages/closer/test/service-jobs.test.ts`

**Interfaces:**
- Produces:
  - `type JobState = "accepted" | "running" | "done" | "failed" | "cancelled"`
  - `type Job = { activityId: string; attemptId: string; idempotencyKey: string; state: JobState; cardClaimed: boolean; seq: number }`
  - `createJobStore(): JobStore`
  - `interface JobStore { accept(input: {activityId: string; attemptId: string; idempotencyKey: string}): { job: Job; created: boolean }; get(idempotencyKey: string): Job | undefined; byAttempt(attemptId: string): Job | undefined; setState(idempotencyKey: string, state: JobState): void; claimCardOnce(idempotencyKey: string): boolean; cancel(activityId: string, attemptId?: string): void; isCancelled(attemptId: string): boolean; nextSeq(idempotencyKey: string): number }`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/closer/test/service-jobs.test.ts
import { describe, expect, it } from "vitest";
import { createJobStore } from "../src/service/jobs.js";

const input = { activityId: "act_1", attemptId: "attempt_1", idempotencyKey: "k1" };

describe("job store", () => {
  it("accepts a new key once and reports the repeat as not created", () => {
    const store = createJobStore();
    const first = store.accept(input);
    const second = store.accept(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.attemptId).toBe("attempt_1");
  });

  it("lets exactly one caller claim the card for a key", () => {
    const store = createJobStore();
    store.accept(input);
    expect(store.claimCardOnce("k1")).toBe(true);
    expect(store.claimCardOnce("k1")).toBe(false);
    expect(store.claimCardOnce("k1")).toBe(false);
  });

  it("marks an attempt cancelled and reports it", () => {
    const store = createJobStore();
    store.accept(input);
    expect(store.isCancelled("attempt_1")).toBe(false);
    store.cancel("act_1", "attempt_1");
    expect(store.isCancelled("attempt_1")).toBe(true);
  });

  it("cancels every attempt of an activity when no attempt is named", () => {
    const store = createJobStore();
    store.accept(input);
    store.accept({ activityId: "act_1", attemptId: "attempt_2", idempotencyKey: "k2" });
    store.cancel("act_1");
    expect(store.isCancelled("attempt_1")).toBe(true);
    expect(store.isCancelled("attempt_2")).toBe(true);
  });

  it("hands out increasing sequence numbers per key", () => {
    const store = createJobStore();
    store.accept(input);
    expect(store.nextSeq("k1")).toBe(1);
    expect(store.nextSeq("k1")).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @happy/closer exec vitest run test/service-jobs.test.ts`
Expected: FAIL — cannot resolve `../src/service/jobs.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/closer/src/service/jobs.ts
/**
 * Job and idempotency records for the purchase service.
 *
 * In memory on purpose: a hackathon run is one process, and a durable store would need a schema,
 * migrations and a cleanup story for no benefit this weekend. The one guarantee that genuinely
 * matters — a card is claimed at most once per idempotency key — is enforced here rather than by
 * convention at the call site, because getting it wrong spends real money twice.
 */
export type JobState = "accepted" | "running" | "done" | "failed" | "cancelled";

export type Job = {
  activityId: string;
  attemptId: string;
  idempotencyKey: string;
  state: JobState;
  cardClaimed: boolean;
  seq: number;
};

export interface JobStore {
  accept(input: {
    activityId: string;
    attemptId: string;
    idempotencyKey: string;
  }): { job: Job; created: boolean };
  get(idempotencyKey: string): Job | undefined;
  byAttempt(attemptId: string): Job | undefined;
  setState(idempotencyKey: string, state: JobState): void;
  /** True for the first caller only. Every later caller gets false. */
  claimCardOnce(idempotencyKey: string): boolean;
  cancel(activityId: string, attemptId?: string): void;
  isCancelled(attemptId: string): boolean;
  nextSeq(idempotencyKey: string): number;
}

export function createJobStore(): JobStore {
  const byKey = new Map<string, Job>();
  const cancelled = new Set<string>();

  return {
    accept(input) {
      const existing = byKey.get(input.idempotencyKey);
      if (existing) return { job: existing, created: false };
      const job: Job = { ...input, state: "accepted", cardClaimed: false, seq: 0 };
      byKey.set(input.idempotencyKey, job);
      return { job, created: true };
    },

    get: (key) => byKey.get(key),

    byAttempt: (attemptId) => [...byKey.values()].find((j) => j.attemptId === attemptId),

    setState(key, state) {
      const job = byKey.get(key);
      if (job) job.state = state;
    },

    claimCardOnce(key) {
      const job = byKey.get(key);
      if (!job || job.cardClaimed) return false;
      job.cardClaimed = true;
      return true;
    },

    cancel(activityId, attemptId) {
      if (attemptId) {
        cancelled.add(attemptId);
        return;
      }
      for (const job of byKey.values()) {
        if (job.activityId === activityId) cancelled.add(job.attemptId);
      }
    },

    isCancelled: (attemptId) => cancelled.has(attemptId),

    nextSeq(key) {
      const job = byKey.get(key);
      if (!job) return 0;
      job.seq += 1;
      return job.seq;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @happy/closer exec vitest run test/service-jobs.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/closer/src/service/jobs.ts packages/closer/test/service-jobs.test.ts
git commit -m "Add the purchase service job store

Enforces the one guarantee that costs real money if it is wrong: a card is
claimed at most once per idempotency key. Putting claimCardOnce here rather
than trusting the call site means a duplicate POST cannot spend twice."
```

---

### Task 2: Callbacks with derived event ids and bounded retry

**Files:**
- Create: `packages/closer/src/service/callbacks.ts`
- Test: `packages/closer/test/service-callbacks.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type CallbackTarget = { url: string; token?: string | undefined }`
  - `type PurchaseEvent = { type: "browser.started"; liveStreamUrl: string; message?: string } | { type: "checkout.prepared"; message?: string } | { type: "order.placing"; message?: string } | { type: "order.confirmed"; orderId: string; message?: string } | { type: "purchase.failed"; message: string; retryable?: boolean }`
  - `eventIdFor(attemptId: string, type: string, seq: number): string`
  - `sendCallback(target: CallbackTarget, base: {attemptId: string; itemId: string; eventId: string}, event: PurchaseEvent, opts?: {attempts?: number; fetchImpl?: typeof fetch}): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/closer/test/service-callbacks.test.ts
import { describe, expect, it } from "vitest";
import { eventIdFor, sendCallback } from "../src/service/callbacks.js";

const target = { url: "https://happy.test/events", token: "cb-secret" };
const base = { attemptId: "attempt_1", itemId: "item-1", eventId: "" };

describe("callbacks", () => {
  it("derives the same event id for the same logical event", () => {
    expect(eventIdFor("attempt_1", "order.placing", 3)).toBe(
      eventIdFor("attempt_1", "order.placing", 3),
    );
  });

  it("derives different ids for different events", () => {
    expect(eventIdFor("attempt_1", "order.placing", 3)).not.toBe(
      eventIdFor("attempt_1", "order.confirmed", 3),
    );
  });

  it("posts the bearer token, the base fields and the event body", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await sendCallback(
      target,
      { ...base, eventId: "e1" },
      { type: "order.confirmed", orderId: "ORD-1" },
      { fetchImpl },
    );

    expect(ok).toBe(true);
    const call = seen[0];
    expect(call?.url).toBe("https://happy.test/events");
    expect((call?.init.headers as Record<string, string>).authorization).toBe("Bearer cb-secret");
    const body = JSON.parse(String(call?.init.body));
    expect(body).toMatchObject({
      eventId: "e1",
      attemptId: "attempt_1",
      itemId: "item-1",
      type: "order.confirmed",
      orderId: "ORD-1",
    });
  });

  it("retries a failure with the SAME event id, then gives up without throwing", async () => {
    const ids: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      ids.push(JSON.parse(String(init?.body)).eventId);
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const ok = await sendCallback(
      target,
      { ...base, eventId: "stable-1" },
      { type: "order.placing" },
      { attempts: 3, fetchImpl },
    );

    expect(ok).toBe(false);
    expect(ids).toEqual(["stable-1", "stable-1", "stable-1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @happy/closer exec vitest run test/service-callbacks.test.ts`
Expected: FAIL — cannot resolve `../src/service/callbacks.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/closer/src/service/callbacks.ts
import { createHash } from "node:crypto";

/**
 * Progress reports back to Happy.
 *
 * Event ids are DERIVED rather than random. Happy deduplicates on eventId, so a retry of the same
 * logical event must carry the same id — a random one would show the user "placing order" twice
 * because our first POST happened to time out.
 *
 * A callback that never lands is logged and swallowed. The purchase already happened by then;
 * failing to narrate it does not un-happen it, and throwing here would abort a run that is
 * mid-checkout with a live card.
 */
export type CallbackTarget = { url: string; token?: string | undefined };

export type PurchaseEvent =
  | { type: "browser.started"; liveStreamUrl: string; message?: string }
  | { type: "checkout.prepared"; message?: string }
  | { type: "order.placing"; message?: string }
  | { type: "order.confirmed"; orderId: string; message?: string }
  | { type: "purchase.failed"; message: string; retryable?: boolean };

export function eventIdFor(attemptId: string, type: string, seq: number): string {
  return createHash("sha256").update(`${attemptId}:${type}:${seq}`).digest("hex").slice(0, 32);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendCallback(
  target: CallbackTarget,
  base: { attemptId: string; itemId: string; eventId: string },
  event: PurchaseEvent,
  opts: { attempts?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({ ...base, ...event });

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
        },
        body,
      });
      if (res.ok) return true;
    } catch {
      /* network failures are retried like any other */
    }
    if (i < attempts - 1) await delay(200 * 2 ** i);
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @happy/closer exec vitest run test/service-callbacks.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/closer/src/service/callbacks.ts packages/closer/test/service-callbacks.test.ts
git commit -m "Report purchase progress with derived event ids

Happy deduplicates on eventId, so a retried callback must reuse the id of the
event it is retrying — a random one shows the user the same step twice because
our first POST timed out. A callback that never lands is swallowed: the
purchase already happened, and throwing would abort a run holding a live card."
```

---

### Task 3: The pre-card verification gate

**Files:**
- Create: `packages/closer/src/service/verify.ts`
- Test: `packages/closer/test/service-verify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PurchaseJobInput = { activityId: string; attemptId: string; item: { id: string; name: string; spec?: string }; listing: { url?: string; title: string; seller: string; price: string; amountMinor: number }; cardGrant: { claimUrl: string; token: string; amountMinor: number; currency: string; expiresAt: string }; sandbox: boolean; idempotencyKey: string; amountMinor: number; callback: { url: string; token?: string } }`
  - `verifyGrant(job: PurchaseJobInput, now?: Date): string | null` — returns a failure reason, or `null` when every payload check passes
  - `verifyMerchantTotal(displayedMinor: number, approvedMinor: number): string | null`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/closer/test/service-verify.test.ts
import { describe, expect, it } from "vitest";
import { type PurchaseJobInput, verifyGrant, verifyMerchantTotal } from "../src/service/verify.js";

const job = (over: Partial<PurchaseJobInput> = {}): PurchaseJobInput => ({
  activityId: "act_1",
  attemptId: "attempt_1",
  item: { id: "item-1", name: "Kenya AB Kiamwangi" },
  listing: {
    url: "https://nylon.coffee/products/kenya-ab-kiamwangi",
    title: "Kenya AB Kiamwangi",
    seller: "Nylon Coffee",
    price: "S$23.50",
    amountMinor: 2350,
  },
  cardGrant: {
    claimUrl: "https://happy.test/claim",
    token: "grant",
    amountMinor: 2350,
    currency: "SGD",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
  sandbox: true,
  idempotencyKey: "k1",
  amountMinor: 2350,
  callback: { url: "https://happy.test/events" },
  ...over,
});

describe("verification gate", () => {
  it("passes a well-formed job", () => {
    expect(verifyGrant(job())).toBeNull();
  });

  it("rejects a grant amount that disagrees with the listing", () => {
    const bad = job();
    bad.cardGrant.amountMinor = 9900;
    expect(verifyGrant(bad)).toMatch(/amount/i);
  });

  it("rejects a currency that is not SGD", () => {
    const bad = job();
    bad.cardGrant.currency = "USD";
    expect(verifyGrant(bad)).toMatch(/currency/i);
  });

  it("rejects an expired grant", () => {
    const bad = job();
    bad.cardGrant.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(verifyGrant(bad)).toMatch(/expired/i);
  });

  it("rejects a listing with no url", () => {
    const bad = job();
    bad.listing.url = undefined;
    expect(verifyGrant(bad)).toMatch(/url/i);
  });

  it("rejects a non-http listing url", () => {
    const bad = job();
    bad.listing.url = "file:///etc/passwd";
    expect(verifyGrant(bad)).toMatch(/url/i);
  });

  it("accepts a merchant total at or under the approved amount", () => {
    expect(verifyMerchantTotal(2350, 2350)).toBeNull();
    expect(verifyMerchantTotal(2000, 2350)).toBeNull();
  });

  it("rejects a merchant total even one cent over", () => {
    expect(verifyMerchantTotal(2351, 2350)).toMatch(/exceeds/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @happy/closer exec vitest run test/service-verify.test.ts`
Expected: FAIL — cannot resolve `../src/service/verify.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/closer/src/service/verify.ts
/**
 * Everything that must be true before a card is claimed.
 *
 * Ordered deliberately: these run while a failure is still free. Once the card exists it has a
 * ten-minute life and is destroyed by its first authorisation, so a check that fires after
 * issuance costs a card whatever it decides.
 */
export type PurchaseJobInput = {
  activityId: string;
  attemptId: string;
  item: { id: string; name: string; spec?: string };
  listing: {
    url?: string | undefined;
    title: string;
    seller: string;
    price: string;
    amountMinor: number;
  };
  cardGrant: {
    claimUrl: string;
    token: string;
    amountMinor: number;
    currency: string;
    expiresAt: string;
  };
  sandbox: boolean;
  idempotencyKey: string;
  amountMinor: number;
  callback: { url: string; token?: string | undefined };
};

/** Returns a human-readable reason, or null when the payload is sound. */
export function verifyGrant(job: PurchaseJobInput, now: Date = new Date()): string | null {
  const url = job.listing.url;
  if (!url) return "listing has no url, so there is nothing to verify against";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `listing url is not a url: ${url}`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `listing url is not http(s): ${parsed.protocol}`;
  }

  if (job.cardGrant.currency !== "SGD") {
    return `card grant currency is ${job.cardGrant.currency}, expected SGD`;
  }
  if (job.cardGrant.amountMinor !== job.listing.amountMinor) {
    return `card grant amount ${job.cardGrant.amountMinor} does not equal listing amount ${job.listing.amountMinor}`;
  }
  if (job.amountMinor !== job.listing.amountMinor) {
    return `job amount ${job.amountMinor} does not equal listing amount ${job.listing.amountMinor}`;
  }

  const expires = Date.parse(job.cardGrant.expiresAt);
  if (Number.isNaN(expires)) return `card grant expiresAt is not a date: ${job.cardGrant.expiresAt}`;
  if (expires <= now.getTime()) return "card grant has expired";

  return null;
}

/**
 * The merchant's own displayed total against what was approved.
 *
 * Read from the page, never computed and never taken from the payload — a merchant that nudges the
 * price a couple of percent between shortlist and checkout is exactly what this catches.
 */
export function verifyMerchantTotal(
  displayedMinor: number,
  approvedMinor: number,
): string | null {
  if (displayedMinor > approvedMinor) {
    return `merchant total ${displayedMinor} exceeds approved ${approvedMinor}`;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @happy/closer exec vitest run test/service-verify.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add packages/closer/src/service/verify.ts packages/closer/test/service-verify.test.ts
git commit -m "Gate the card claim on verification that runs while failure is free

Every check here fires before the card exists. Afterwards it has ten minutes
and dies on first authorisation, so a check that runs late costs a card
whatever it decides. The merchant total is read from the page rather than
taken from the payload, which is what catches a price nudged between shortlist
and checkout."
```

---

### Task 4: Card claim and reveal, with the material confined

**Files:**
- Create: `packages/closer/src/service/card.ts`
- Test: `packages/closer/test/service-card.test.ts`

**Interfaces:**
- Consumes: `JobStore` from Task 1 (`claimCardOnce`).
- Produces:
  - `type CardMaterial = { pan: string; expiryMonth: string; expiryYear: string; cvc: string }`
  - `type ClaimedCard = { cardId: string; last4: string; agentAccess: { revealUrl: string; token: string; expiresAt?: string } }`
  - `claimCard(grant: {claimUrl: string; token: string}, fetchImpl?: typeof fetch): Promise<ClaimedCard>`
  - `revealCard(access: {revealUrl: string; token: string}, fetchImpl?: typeof fetch): Promise<CardMaterial>`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/closer/test/service-card.test.ts
import { describe, expect, it } from "vitest";
import { claimCard, revealCard } from "../src/service/card.js";

describe("card claim and reveal", () => {
  it("claims with the grant token and returns the agent capability", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(
        JSON.stringify({
          cardId: "card_1",
          last4: "4242",
          agentAccess: { revealUrl: "https://happy.test/reveal", token: "one-use" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const card = await claimCard({ claimUrl: "https://happy.test/claim", token: "grant" }, fetchImpl);
    expect(card.last4).toBe("4242");
    expect((seen[0]?.headers as Record<string, string>).authorization).toBe("Bearer grant");
    expect(seen[0]?.method).toBe("POST");
  });

  it("throws with the status when a claim is refused", async () => {
    const fetchImpl = (async () =>
      new Response("no", { status: 409 })) as unknown as typeof fetch;
    await expect(
      claimCard({ claimUrl: "https://happy.test/claim", token: "grant" }, fetchImpl),
    ).rejects.toThrow(/409/);
  });

  it("reveals with the one-use token and returns the material", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(
        JSON.stringify({ pan: "4242424242424242", expiryMonth: "12", expiryYear: "40", cvc: "123" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const material = await revealCard(
      { revealUrl: "https://happy.test/reveal", token: "one-use" },
      fetchImpl,
    );
    expect(material.pan).toBe("4242424242424242");
    expect((seen[0]?.headers as Record<string, string>).authorization).toBe("Bearer one-use");
    expect(seen[0]?.method ?? "GET").toBe("GET");
  });

  it("rejects a reveal payload missing the pan rather than returning a partial card", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ expiryMonth: "12" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(
      revealCard({ revealUrl: "https://happy.test/reveal", token: "t" }, fetchImpl),
    ).rejects.toThrow(/card/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @happy/closer exec vitest run test/service-card.test.ts`
Expected: FAIL — cannot resolve `../src/service/card.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/closer/src/service/card.ts
/**
 * Claiming and revealing the card Happy issued.
 *
 * Two rules govern this file and neither is negotiable. The claim happens at most once per
 * attempt — enforced by the job store, not here, because a guard next to the fetch is a guard
 * someone reorders. And nothing in here is ever logged: the values it returns are the card, so an
 * error message that interpolates the response body is a card leak.
 */
export type CardMaterial = {
  pan: string;
  expiryMonth: string;
  expiryYear: string;
  cvc: string;
};

export type ClaimedCard = {
  cardId: string;
  last4: string;
  agentAccess: { revealUrl: string; token: string; expiresAt?: string };
};

export async function claimCard(
  grant: { claimUrl: string; token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimedCard> {
  const res = await fetchImpl(grant.claimUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${grant.token}` },
  });
  // Deliberately does not include the body: a claim response carries card metadata.
  if (!res.ok) throw new Error(`card claim refused (${res.status})`);
  const data = (await res.json()) as ClaimedCard;
  if (!data?.agentAccess?.revealUrl || !data.agentAccess.token) {
    throw new Error("card claim returned no agent access capability");
  }
  return data;
}

export async function revealCard(
  access: { revealUrl: string; token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CardMaterial> {
  const res = await fetchImpl(access.revealUrl, {
    method: "GET",
    headers: { authorization: `Bearer ${access.token}` },
  });
  if (!res.ok) throw new Error(`card reveal refused (${res.status})`);
  const data = (await res.json()) as Partial<CardMaterial>;
  if (!data.pan || !data.expiryMonth || !data.expiryYear || !data.cvc) {
    // Names the missing field kinds, never the values.
    throw new Error("card reveal returned incomplete card material");
  }
  return {
    pan: data.pan,
    expiryMonth: data.expiryMonth,
    expiryYear: data.expiryYear,
    cvc: data.cvc,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @happy/closer exec vitest run test/service-card.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/closer/src/service/card.ts packages/closer/test/service-card.test.ts
git commit -m "Claim and reveal the card without ever logging it

Error paths name the status and the missing field kinds, never the response
body — a claim or reveal body IS the card, so interpolating it into a message
is a leak into whatever collects logs. The claim-once guarantee lives in the
job store rather than beside the fetch, where a reorder could skip it."
```

---

### Task 5: The embeddable live view, blankable across card entry

**Files:**
- Create: `packages/closer/src/service/liveview.ts`
- Test: `packages/closer/test/service-liveview.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createLiveView(): LiveView`
  - `interface LiveView { page(attemptId: string): string; attach(attemptId: string, res: import("node:http").ServerResponse): void; push(attemptId: string, jpegBase64: string): void; blank(attemptId: string, reason: string): void; resume(attemptId: string): void; isBlanked(attemptId: string): boolean; close(attemptId: string): void }`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/closer/test/service-liveview.test.ts
import { describe, expect, it } from "vitest";
import { createLiveView } from "../src/service/liveview.js";

function fakeRes() {
  const chunks: string[] = [];
  return {
    chunks,
    res: {
      writeHead: () => {},
      write: (s: string) => chunks.push(s),
      end: () => {},
      writableLength: 0,
      on: () => {},
    } as never,
  };
}

describe("live view", () => {
  it("serves an html page that references the stream for the attempt", () => {
    const view = createLiveView();
    const html = view.page("attempt_1");
    expect(html).toContain("<canvas");
    expect(html).toContain("attempt_1");
  });

  it("pushes frames to an attached subscriber", () => {
    const view = createLiveView();
    const { chunks, res } = fakeRes();
    view.attach("attempt_1", res);
    view.push("attempt_1", "AAAA");
    expect(chunks.join("")).toContain("AAAA");
  });

  it("drops frames while blanked and sends them again after resume", () => {
    const view = createLiveView();
    const { chunks, res } = fakeRes();
    view.attach("attempt_1", res);

    view.blank("attempt_1", "card entry in progress");
    const afterBlank = chunks.length;
    view.push("attempt_1", "SECRET");
    expect(chunks.join("")).not.toContain("SECRET");
    expect(view.isBlanked("attempt_1")).toBe(true);
    expect(chunks.length).toBeGreaterThan(afterBlank - 1);

    view.resume("attempt_1");
    view.push("attempt_1", "VISIBLE");
    expect(chunks.join("")).toContain("VISIBLE");
    expect(view.isBlanked("attempt_1")).toBe(false);
  });

  it("keeps attempts independent", () => {
    const view = createLiveView();
    const a = fakeRes();
    const b = fakeRes();
    view.attach("attempt_a", a.res);
    view.attach("attempt_b", b.res);
    view.blank("attempt_a", "card entry in progress");
    view.push("attempt_a", "HIDDEN");
    view.push("attempt_b", "SHOWN");
    expect(a.chunks.join("")).not.toContain("HIDDEN");
    expect(b.chunks.join("")).toContain("SHOWN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @happy/closer exec vitest run test/service-liveview.test.ts`
Expected: FAIL — cannot resolve `../src/service/liveview.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/closer/src/service/liveview.ts
import type { ServerResponse } from "node:http";

/**
 * The page behind `liveStreamUrl`.
 *
 * Happy persists that URL in its event log and the frontend renders it in an iframe, so anyone who
 * can read an activity can open it. The card is typed into the same browser these frames come
 * from — so the stream is BLANKED from just before the card is revealed until after submit. That
 * is invariant 10 applied to pixels rather than to code paths: the number never reaches a frame
 * the frontend could render, and never reaches whoever reopens the URL later.
 *
 * AgentCore's own live view cannot be used here. Its endpoint is an Amazon DCV transport that
 * answers 501 to a plain GET, and the DCV client is a licensed AWS download rather than an npm
 * package — measured, see docs/agentcore-browser.md.
 */
export interface LiveView {
  page(attemptId: string): string;
  attach(attemptId: string, res: ServerResponse): void;
  push(attemptId: string, jpegBase64: string): void;
  blank(attemptId: string, reason: string): void;
  resume(attemptId: string): void;
  isBlanked(attemptId: string): boolean;
  close(attemptId: string): void;
}

type Channel = { clients: Set<ServerResponse>; blanked: boolean };

export function createLiveView(): LiveView {
  const channels = new Map<string, Channel>();
  const channel = (id: string) => {
    let c = channels.get(id);
    if (!c) {
      c = { clients: new Set(), blanked: false };
      channels.set(id, c);
    }
    return c;
  };

  const emit = (id: string, line: string) => {
    for (const res of channel(id).clients) {
      // Drop rather than queue for a backed-up subscriber: an unbounded buffer becomes seconds of
      // latency that never recovers, and a skipped frame is invisible.
      if (res.writableLength > 1_000_000) continue;
      res.write(line);
    }
  };

  return {
    page: (attemptId) => `<!doctype html>
<meta charset="utf-8">
<title>Closer live view</title>
<style>
  html,body{margin:0;background:#0d0d10;color:#e7e7ea;font:13px system-ui,sans-serif;height:100%}
  #wrap{display:flex;align-items:center;justify-content:center;height:100%}
  canvas{max-width:100%;max-height:100%;display:block}
  #msg{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
       text-align:center;padding:24px;background:#0d0d10}
</style>
<div id="wrap"><canvas id="c"></canvas></div>
<div id="msg"></div>
<script>
  const attemptId = ${JSON.stringify(attemptId)};
  const c = document.getElementById('c'), ctx = c.getContext('2d'), msg = document.getElementById('msg');
  const es = new EventSource('/v1/live/' + encodeURIComponent(attemptId) + '/stream');
  es.addEventListener('frame', (e) => {
    const img = new Image();
    img.onload = () => {
      if (c.width !== img.width || c.height !== img.height) { c.width = img.width; c.height = img.height; }
      ctx.drawImage(img, 0, 0);
    };
    img.src = 'data:image/jpeg;base64,' + e.data;
  });
  es.addEventListener('blank', (e) => { msg.textContent = e.data; msg.style.display = 'flex'; });
  es.addEventListener('resume', () => { msg.style.display = 'none'; });
</script>`,

    attach(attemptId, res) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      channel(attemptId).clients.add(res);
      if (channel(attemptId).blanked) res.write("event: blank\ndata: card entry in progress\n\n");
      res.on("close", () => channel(attemptId).clients.delete(res));
    },

    push(attemptId, jpegBase64) {
      if (channel(attemptId).blanked) return;
      emit(attemptId, `event: frame\ndata: ${jpegBase64}\n\n`);
    },

    blank(attemptId, reason) {
      channel(attemptId).blanked = true;
      emit(attemptId, `event: blank\ndata: ${reason}\n\n`);
    },

    resume(attemptId) {
      channel(attemptId).blanked = false;
      emit(attemptId, "event: resume\ndata: ok\n\n");
    },

    isBlanked: (attemptId) => channel(attemptId).blanked,

    close(attemptId) {
      for (const res of channel(attemptId).clients) res.end();
      channels.delete(attemptId);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @happy/closer exec vitest run test/service-liveview.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/closer/src/service/liveview.ts packages/closer/test/service-liveview.test.ts
git commit -m "Serve an embeddable live view that blanks across card entry

Happy persists liveStreamUrl in its event log and the frontend renders it in
an iframe, so anyone who can read an activity can open it — and the card is
typed into the browser these frames come from. Blanking from just before the
reveal until after submit is invariant 10 applied to pixels: the number never
reaches a frame the frontend could render.

AgentCore's own live view cannot serve this. Its endpoint is a DCV transport
that answers 501 to a plain GET and its client is a licensed AWS download."
```

---

### Task 6: The purchase run

**Files:**
- Create: `packages/closer/src/service/run.ts`
- Test: `packages/closer/test/service-run.test.ts`

**Interfaces:**
- Consumes: `JobStore` (Task 1), `sendCallback`/`eventIdFor`/`PurchaseEvent` (Task 2), `verifyGrant`/`verifyMerchantTotal`/`PurchaseJobInput` (Task 3), `claimCard`/`revealCard`/`CardMaterial` (Task 4), `LiveView` (Task 5).
- Produces:
  - `type RunDeps = { jobs: JobStore; view: LiveView; browserFor: () => Promise<import("../types.js").BrowserLike>; fetchImpl?: typeof fetch; liveUrlFor: (attemptId: string) => string; fillCard: (page: import("playwright").Page, card: CardMaterial) => Promise<void>; readTotalMinor: (page: import("playwright").Page) => Promise<number>; submit: (page: import("playwright").Page) => Promise<string | null> }`
  - `runPurchase(deps: RunDeps, job: PurchaseJobInput): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/closer/test/service-run.test.ts
import { describe, expect, it, vi } from "vitest";
import { createJobStore } from "../src/service/jobs.js";
import { createLiveView } from "../src/service/liveview.js";
import { runPurchase, type RunDeps } from "../src/service/run.js";
import type { PurchaseJobInput } from "../src/service/verify.js";

const jobInput = (over: Partial<PurchaseJobInput> = {}): PurchaseJobInput => ({
  activityId: "act_1",
  attemptId: "attempt_1",
  item: { id: "item-1", name: "Coffee" },
  listing: {
    url: "https://merchant.test/p/1",
    title: "Coffee",
    seller: "Merchant",
    price: "S$23.50",
    amountMinor: 2350,
  },
  cardGrant: {
    claimUrl: "https://happy.test/claim",
    token: "grant",
    amountMinor: 2350,
    currency: "SGD",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
  sandbox: true,
  idempotencyKey: "k1",
  amountMinor: 2350,
  callback: { url: "https://happy.test/events", token: "cb" },
  ...over,
});

function harness(over: Partial<RunDeps> = {}, totalMinor = 2350, orderRef: string | null = "ORD-9") {
  const posted: any[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/claim")) {
      return new Response(
        JSON.stringify({
          cardId: "c1",
          last4: "4242",
          agentAccess: { revealUrl: "https://happy.test/reveal", token: "one-use" },
        }),
        { status: 200 },
      );
    }
    if (u.includes("/reveal")) {
      return new Response(
        JSON.stringify({ pan: "4242424242424242", expiryMonth: "12", expiryYear: "40", cvc: "123" }),
        { status: 200 },
      );
    }
    posted.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const page = { url: () => "https://merchant.test/p/1" } as never;
  const deps: RunDeps = {
    jobs: createJobStore(),
    view: createLiveView(),
    browserFor: async () => ({ newPage: async () => page }),
    fetchImpl,
    liveUrlFor: (id) => `http://127.0.0.1:4042/v1/live/${id}`,
    fillCard: vi.fn(async () => {}),
    readTotalMinor: async () => totalMinor,
    submit: async () => orderRef,
    ...over,
  };
  return { deps, posted };
}

const types = (posted: any[]) => posted.map((p) => p.type);

describe("purchase run", () => {
  it("emits the full happy-path callback sequence", async () => {
    const { deps, posted } = harness();
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());
    expect(types(posted)).toEqual([
      "browser.started",
      "checkout.prepared",
      "order.placing",
      "order.confirmed",
    ]);
    expect(posted.at(-1).orderId).toBe("ORD-9");
    expect(posted[0].liveStreamUrl).toContain("attempt_1");
  });

  it("never claims a card when the payload fails verification", async () => {
    const { deps, posted } = harness();
    const bad = jobInput();
    bad.cardGrant.currency = "USD";
    deps.jobs.accept(bad);
    await runPurchase(deps, bad);
    expect(types(posted)).toContain("purchase.failed");
    expect(deps.jobs.get("k1")?.cardClaimed).toBe(false);
  });

  it("fails without claiming when the merchant total exceeds the approved amount", async () => {
    const { deps, posted } = harness({}, 2400);
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());
    expect(posted.at(-1).type).toBe("purchase.failed");
    expect(posted.at(-1).message).toMatch(/exceeds/i);
    expect(deps.jobs.get("k1")?.cardClaimed).toBe(false);
  });

  it("reports failure, never success, when the order reference is unknown", async () => {
    const { deps, posted } = harness({}, 2350, null);
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());
    expect(types(posted)).not.toContain("order.confirmed");
    expect(posted.at(-1).type).toBe("purchase.failed");
  });

  it("blanks the live view before revealing and resumes after submit", async () => {
    const states: boolean[] = [];
    const { deps } = harness({
      fillCard: vi.fn(async () => {
        states.push(deps.view.isBlanked("attempt_1"));
      }),
    });
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());
    expect(states).toEqual([true]);
    expect(deps.view.isBlanked("attempt_1")).toBe(false);
  });

  it("never puts card material into any callback", async () => {
    const { deps, posted } = harness();
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());
    const blob = JSON.stringify(posted);
    expect(blob).not.toContain("4242424242424242");
    expect(blob).not.toContain("123");
  });

  it("aborts at the next step once the attempt is cancelled", async () => {
    const { deps, posted } = harness({
      readTotalMinor: async () => {
        deps.jobs.cancel("act_1", "attempt_1");
        return 2350;
      },
    });
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());
    expect(types(posted)).not.toContain("order.confirmed");
    expect(deps.jobs.get("k1")?.cardClaimed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @happy/closer exec vitest run test/service-run.test.ts`
Expected: FAIL — cannot resolve `../src/service/run.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/closer/src/service/run.ts
import type { Page } from "playwright";
import type { BrowserLike } from "../types.js";
import { type CardMaterial, claimCard, revealCard } from "./card.js";
import { eventIdFor, type PurchaseEvent, sendCallback } from "./callbacks.js";
import type { JobStore } from "./jobs.js";
import type { LiveView } from "./liveview.js";
import { type PurchaseJobInput, verifyGrant, verifyMerchantTotal } from "./verify.js";

/**
 * One purchase, start to finish.
 *
 * The ordering is the design. Everything that can fail for free happens before the card is
 * claimed; everything after it is holding something with a ten-minute life that dies on its first
 * authorisation. The live view is blanked across the whole window in which card material exists.
 */
export type RunDeps = {
  jobs: JobStore;
  view: LiveView;
  browserFor: () => Promise<BrowserLike>;
  fetchImpl?: typeof fetch;
  liveUrlFor: (attemptId: string) => string;
  fillCard: (page: Page, card: CardMaterial) => Promise<void>;
  readTotalMinor: (page: Page) => Promise<number>;
  /** Submits and returns an order reference, or null when the outcome is unknown. */
  submit: (page: Page) => Promise<string | null>;
};

class Cancelled extends Error {}

export async function runPurchase(deps: RunDeps, job: PurchaseJobInput): Promise<void> {
  const { attemptId, idempotencyKey } = job;
  const base = { attemptId, itemId: job.item.id };
  const target = job.callback;

  const emit = async (event: PurchaseEvent) => {
    const seq = deps.jobs.nextSeq(idempotencyKey);
    await sendCallback(
      target,
      { ...base, eventId: eventIdFor(attemptId, event.type, seq) },
      event,
      deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
    );
  };

  const checkCancelled = () => {
    if (deps.jobs.isCancelled(attemptId)) throw new Cancelled("attempt cancelled");
  };

  deps.jobs.setState(idempotencyKey, "running");

  try {
    const payloadProblem = verifyGrant(job);
    if (payloadProblem) throw new Error(payloadProblem);

    checkCancelled();
    const browser = await deps.browserFor();
    const page = await browser.newPage();
    await emit({
      type: "browser.started",
      liveStreamUrl: deps.liveUrlFor(attemptId),
      message: `opened ${job.listing.url ?? job.listing.title}`,
    });

    checkCancelled();
    // The merchant's own total, read from the page. Trusting the payload here would let a merchant
    // that nudged the price between shortlist and checkout charge whatever it liked.
    const totalMinor = await deps.readTotalMinor(page);
    const totalProblem = verifyMerchantTotal(totalMinor, job.listing.amountMinor);
    if (totalProblem) throw new Error(totalProblem);

    checkCancelled();
    if (!deps.jobs.claimCardOnce(idempotencyKey)) {
      throw new Error("card already claimed for this attempt");
    }

    // From here until after submit, nothing the browser renders may reach a viewer.
    deps.view.blank(attemptId, "card entry in progress");
    let orderRef: string | null = null;
    try {
      const claimed = await claimCard(job.cardGrant, deps.fetchImpl);
      const material = await revealCard(claimed.agentAccess, deps.fetchImpl);
      await deps.fillCard(page, material);
      await emit({ type: "checkout.prepared", message: `${job.listing.seller}/checkout ready` });

      await emit({ type: "order.placing", message: `placing ${job.listing.price}` });
      orderRef = await deps.submit(page);
    } finally {
      deps.view.resume(attemptId);
    }

    // An unknown outcome is a failure. Money has already moved, so inventing a reference would
    // mark a purchase done that may never have charged.
    if (!orderRef) throw new Error("checkout finished with no order reference");

    await emit({ type: "order.confirmed", orderId: orderRef, message: "merchant confirmed" });
    deps.jobs.setState(idempotencyKey, "done");
  } catch (error) {
    const cancelled = error instanceof Cancelled;
    deps.jobs.setState(idempotencyKey, cancelled ? "cancelled" : "failed");
    await emit({
      type: "purchase.failed",
      message: error instanceof Error ? error.message : "purchase failed",
      retryable: !cancelled,
    });
  } finally {
    deps.view.close(attemptId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @happy/closer exec vitest run test/service-run.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add packages/closer/src/service/run.ts packages/closer/test/service-run.test.ts
git commit -m "Run one purchase, ordered so failure is free until it cannot be

Everything that can fail without cost happens before the card is claimed.
After that we hold something with a ten-minute life that dies on its first
authorisation, so the merchant total is read from the page and checked, and
cancellation is polled, while stopping is still free.

An unknown outcome reports purchase.failed rather than order.confirmed: money
has moved by then, and inventing a reference marks a purchase done that may
never have charged."
```

---

### Task 7: The HTTP surface

**Files:**
- Create: `packages/closer/src/service/server.ts`
- Test: `packages/closer/test/service-server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces:
  - `createPurchaseServer(opts: { token: string; jobs?: JobStore; view?: LiveView; startRun: (job: PurchaseJobInput) => void }): import("node:http").Server`
  - `startPurchaseService(): Promise<import("node:http").Server>` — reads `PURCHASE_AGENT_API_TOKEN`, `CLOSER_SERVICE_PORT` (default 4042), `CLOSER_BROWSER`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/closer/test/service-server.test.ts
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPurchaseServer } from "../src/service/server.js";
import type { PurchaseJobInput } from "../src/service/verify.js";

const startRun = vi.fn();
let base = "";
const server = createPurchaseServer({ token: "secret", startRun });

const body = (over: Record<string, unknown> = {}) => ({
  activityId: "act_1",
  attemptId: "attempt_1",
  item: { id: "item-1", name: "Coffee" },
  listing: {
    url: "https://merchant.test/p/1",
    title: "Coffee",
    seller: "Merchant",
    price: "S$23.50",
    amountMinor: 2350,
  },
  cardGrant: {
    claimUrl: "https://happy.test/claim",
    token: "grant",
    amountMinor: 2350,
    currency: "SGD",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
  sandbox: true,
  idempotencyKey: "k1",
  amountMinor: 2350,
  callback: { url: "https://happy.test/events", token: "cb" },
  ...over,
});

const post = (path: string, payload: unknown, token = "secret") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("purchase service http", () => {
  it("rejects a missing token with 401 and starts nothing", async () => {
    startRun.mockClear();
    const res = await post("/v1/purchase-runs", body(), "");
    expect(res.status).toBe(401);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("rejects a wrong token with 401", async () => {
    const res = await post("/v1/purchase-runs", body(), "nope");
    expect(res.status).toBe(401);
  });

  it("accepts a valid job with 202 and starts exactly one run", async () => {
    startRun.mockClear();
    const res = await post("/v1/purchase-runs", body({ idempotencyKey: "kA" }));
    expect(res.status).toBe(202);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a repeat key returns 202 and starts nothing new", async () => {
    startRun.mockClear();
    await post("/v1/purchase-runs", body({ idempotencyKey: "kB" }));
    const again = await post("/v1/purchase-runs", body({ idempotencyKey: "kB" }));
    expect(again.status).toBe(202);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await post("/v1/purchase-runs", { activityId: "act_1" });
    expect(res.status).toBe(400);
  });

  it("acknowledges a cancel with 200, even for an unknown attempt", async () => {
    const res = await post("/v1/purchase-runs/act_zzz/cancel", {
      attemptId: "attempt_zzz",
      reason: "user cancelled",
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @happy/closer exec vitest run test/service-server.test.ts`
Expected: FAIL — cannot resolve `../src/service/server.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/closer/src/service/server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chromium } from "playwright";
import { startAgentCoreSession } from "../agentcore.js";
import type { BrowserLike } from "../types.js";
import { createJobStore, type JobStore } from "./jobs.js";
import { createLiveView, type LiveView } from "./liveview.js";
import { runPurchase } from "./run.js";
import type { PurchaseJobInput } from "./verify.js";

/**
 * The two endpoints Happy already knows how to call, plus the live view they reference.
 *
 * node:http rather than a framework: this is three routes, and the rest of packages/closer has no
 * HTTP dependency worth adding one for.
 */
export function createPurchaseServer(opts: {
  token: string;
  jobs?: JobStore;
  view?: LiveView;
  startRun: (job: PurchaseJobInput) => void;
}): Server {
  const jobs = opts.jobs ?? createJobStore();
  const view = opts.view ?? createLiveView();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    // The live view is opened by a browser in an iframe and cannot carry a bearer token, so it sits
    // outside the authenticated surface. It exposes pixels of a page the operator already approved,
    // and is blanked across card entry.
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "live") {
      const attemptId = decodeURIComponent(parts[2] ?? "");
      if (parts[3] === "stream") return view.attach(attemptId, res);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(view.page(attemptId));
    }

    if (req.method !== "POST") return send(res, 404, { error: "not found" });

    if (req.headers.authorization !== `Bearer ${opts.token}`) {
      return send(res, 401, { error: "unauthorized" });
    }

    const body = await readJson(req);

    if (parts[0] === "v1" && parts[1] === "purchase-runs" && parts.length === 2) {
      const job = body as PurchaseJobInput;
      if (
        !job?.activityId ||
        !job.attemptId ||
        !job.idempotencyKey ||
        !job.item?.id ||
        !job.listing ||
        !job.cardGrant ||
        !job.callback?.url
      ) {
        return send(res, 400, { error: "malformed purchase job" });
      }
      const { created } = jobs.accept(job);
      // Accepted before anything slow happens: Happy times out at 15 seconds and treats a late
      // answer as a 502, which would strand a run we are about to start.
      send(res, 202, { accepted: true, duplicate: !created });
      if (created) opts.startRun(job);
      return;
    }

    if (parts[0] === "v1" && parts[1] === "purchase-runs" && parts[3] === "cancel") {
      const activityId = decodeURIComponent(parts[2] ?? "");
      const attemptId = (body as { attemptId?: string })?.attemptId;
      jobs.cancel(activityId, attemptId);
      // 200 even for an unknown attempt: cancelling something already finished is not an error.
      return send(res, 200, { cancelled: true });
    }

    return send(res, 404, { error: "not found" });
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** AgentCore for the real merchant; a local Chromium for anything on this machine. */
export async function browserForEnv(): Promise<BrowserLike> {
  if ((process.env.CLOSER_BROWSER ?? "local") === "agentcore") {
    const session = await startAgentCoreSession({
      profile: process.env.AWS_PROFILE ?? "happy",
      region: process.env.AWS_REGION ?? "ap-southeast-1",
    });
    return session;
  }
  const browser = await chromium.launch();
  const context = await browser.newContext();
  return { newPage: () => context.newPage() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @happy/closer exec vitest run test/service-server.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add packages/closer/src/service/server.ts packages/closer/test/service-server.test.ts
git commit -m "Expose the two endpoints Happy already calls

202 is sent before the run starts: Happy times out at 15 seconds and treats a
late answer as a 502, which would strand a run we were about to begin. A
repeat idempotency key answers 202 and starts nothing.

The live view sits outside the authenticated surface because an iframe cannot
send a bearer token. It shows pixels of a page the operator already approved,
and is blanked across card entry."
```

---

### Task 8: Wire the run to the real browser and start the service

**Files:**
- Create: `packages/closer/src/service/index.ts`
- Modify: `packages/closer/package.json` (add a `service` script)
- Modify: `.env.example` (document the new variables)
- Test: `packages/closer/test/service-e2e.test.ts`

**Interfaces:**
- Consumes: `createPurchaseServer`, `browserForEnv` (Task 7), `runPurchase` (Task 6).
- Produces: `startPurchaseService(port?: number): Promise<Server>`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/closer/test/service-e2e.test.ts
// Drives the whole service against a fake Happy and apps/demo-store, with a local browser.
// No AWS, no money, no card that can spend.
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "@happy/demo-store";
import { startPurchaseService } from "../src/service/index.js";

let storeUrl = "";
let happyUrl = "";
let serviceUrl = "";
const events: any[] = [];
let store: ReturnType<typeof serve>;
let happy: ReturnType<typeof createServer>;
let service: Awaited<ReturnType<typeof startPurchaseService>>;

beforeAll(async () => {
  store = serve({ fetch: app.fetch, port: 0 });
  storeUrl = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;

  // A fake Happy: claim, reveal, and a callback sink.
  happy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";
    if (url.includes("/claim")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          cardId: "c1",
          last4: "4242",
          agentAccess: { revealUrl: `${happyUrl}/reveal`, token: "one-use" },
        }),
      );
    }
    if (url.includes("/reveal")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ pan: "4242424242424242", expiryMonth: "12", expiryYear: "40", cvc: "123" }),
      );
    }
    events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => happy.listen(0, "127.0.0.1", r));
  happyUrl = `http://127.0.0.1:${(happy.address() as AddressInfo).port}`;

  process.env.PURCHASE_AGENT_API_TOKEN = "test-token";
  process.env.CLOSER_BROWSER = "local";
  process.env.CARD_TYPE_DELAY_MS = "0";
  service = await startPurchaseService(0);
  serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => service.close(() => r()));
  await new Promise<void>((r) => happy.close(() => r()));
  store.close();
});

describe("purchase service end to end", () => {
  it("buys the listing and reports the full callback sequence", async () => {
    const res = await fetch(`${serviceUrl}/v1/purchase-runs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        activityId: "act_e2e",
        attemptId: "attempt_e2e",
        item: { id: "ssd", name: "NVMe SSD" },
        listing: {
          url: `${storeUrl}/item/nvme-ssd`,
          title: "NVMe SSD",
          seller: "demo-store",
          price: "S$12.00",
          amountMinor: 1200,
        },
        cardGrant: {
          claimUrl: `${happyUrl}/claim`,
          token: "grant",
          amountMinor: 1200,
          currency: "SGD",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        sandbox: true,
        idempotencyKey: "k-e2e",
        amountMinor: 1200,
        callback: { url: `${happyUrl}/events`, token: "cb" },
      }),
    });
    expect(res.status).toBe(202);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !events.some((e) => e.type === "order.confirmed" || e.type === "purchase.failed")) {
      await new Promise((r) => setTimeout(r, 250));
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("browser.started");
    expect(types).toContain("order.confirmed");
    expect(JSON.stringify(events)).not.toContain("4242424242424242");
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @happy/closer exec vitest run test/service-e2e.test.ts`
Expected: FAIL — cannot resolve `../src/service/index.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/closer/src/service/index.ts
import type { Server } from "node:http";
import type { Page } from "playwright";
import { SELECTOR_SETS, typeCardInto } from "./fill.js";
import { createJobStore } from "./jobs.js";
import { createLiveView } from "./liveview.js";
import { runPurchase } from "./run.js";
import { browserForEnv, createPurchaseServer } from "./server.js";
import type { PurchaseJobInput } from "./verify.js";

export async function startPurchaseService(port?: number): Promise<Server> {
  const token = process.env.PURCHASE_AGENT_API_TOKEN;
  if (!token) throw new Error("PURCHASE_AGENT_API_TOKEN is required");
  const listenPort = port ?? Number(process.env.CLOSER_SERVICE_PORT ?? 4042);

  const jobs = createJobStore();
  const view = createLiveView();

  const server = createPurchaseServer({
    token,
    jobs,
    view,
    startRun: (job: PurchaseJobInput) => {
      const publicBase =
        process.env.CLOSER_PUBLIC_BASE_URL ??
        `http://127.0.0.1:${(server.address() as { port: number } | null)?.port ?? listenPort}`;
      void runPurchase(
        {
          jobs,
          view,
          browserFor: browserForEnv,
          liveUrlFor: (attemptId) =>
            `${publicBase}/v1/live/${encodeURIComponent(attemptId)}`,
          fillCard: typeCardInto,
          readTotalMinor: readTotalMinorFrom,
          submit: submitAndReadOrderRef,
        },
        job,
      );
    },
  });

  await new Promise<void>((r) => server.listen(listenPort, "127.0.0.1", r));
  return server;
}

/** The merchant's own total, from structured markup. Never merchant prose, never the payload. */
async function readTotalMinorFrom(page: Page): Promise<number> {
  const raw = await page.locator("[data-total-cents]").first().getAttribute("data-total-cents");
  if (raw) return Number(raw);
  throw new Error("could not read the merchant's total from the page");
}

/**
 * Submits and looks for an order reference.
 *
 * Deliberately does NOT wait for a top-level navigation. A gateway's 3DS challenge is a modal
 * iframe on the same page, and demanding navigation turns every challenge into a timeout — a
 * cancelled purchase and a card stranded with money already spent.
 */
async function submitAndReadOrderRef(page: Page): Promise<string | null> {
  const submit = page
    .getByRole("button", { name: /pay now|place order|complete order|^pay\b|confirm order/i })
    .first();
  if ((await submit.count()) === 0) return null;
  await submit.click();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ref = await page
      .locator("[data-order-ref]")
      .first()
      .getAttribute("data-order-ref")
      .catch(() => null);
    if (ref) return ref;
    await page.waitForTimeout(400);
  }
  return null;
}
```

```typescript
// packages/closer/src/service/fill.ts
import type { Page } from "playwright";
import type { CardMaterial } from "./card.js";

/**
 * Card field selectors, matching what packages/pay uses. PCI DSS pushes serious gateways to render
 * the number inside an iframe they control — Shopify serves it from checkout.pci.shopifyinc.com —
 * and page-level locators do not cross frame boundaries, so every frame is searched.
 */
export const SELECTOR_SETS = {
  number: [
    'input[autocomplete="cc-number"]',
    'input[name*="card" i][name*="num" i]',
    'input[id*="cardnumber" i]',
    'input[name="cardNumber"]',
  ],
  expiry: ['input[autocomplete="cc-exp"]', 'input[name*="exp" i]', 'input[id*="exp" i]'],
  cvc: [
    'input[autocomplete="cc-csc"]',
    'input[name*="cvc" i]',
    'input[name*="cvv" i]',
    'input[id*="cvc" i]',
  ],
};

const typeDelayMs = () => {
  const override = process.env.CARD_TYPE_DELAY_MS;
  if (override !== undefined && override !== "") return Number(override);
  return 70 + Math.random() * 80;
};

async function fillFirst(page: Page, candidates: string[], value: string): Promise<boolean> {
  const scopes = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const sel of candidates) {
    for (const scope of scopes) {
      const el = scope.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click();
        // Typed, never fill(). Sixteen digits appearing instantly with no keystrokes is a named
        // fraud signal, and the 3DS challenge it invites kills a single-use card.
        await el.pressSequentially(value, { delay: typeDelayMs() });
        return true;
      }
    }
  }
  return false;
}

export async function typeCardInto(page: Page, card: CardMaterial): Promise<void> {
  if (!(await fillFirst(page, SELECTOR_SETS.number, card.pan))) {
    throw new Error("no card number field in any frame of this page");
  }
  await fillFirst(page, SELECTOR_SETS.expiry, `${card.expiryMonth}/${card.expiryYear}`);
  await fillFirst(page, SELECTOR_SETS.cvc, card.cvc);
}
```

Also add to `packages/closer/package.json` scripts:

```json
"service": "tsx --env-file-if-exists=../../.env src/service/start.ts"
```

And create `packages/closer/src/service/start.ts`:

```typescript
import { startPurchaseService } from "./index.js";

const server = await startPurchaseService();
const addr = server.address();
console.log(
  `closer purchase service  http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : "?"}`,
);
```

And append to `.env.example`:

```bash
# packages/closer — the purchase service Happy dispatches to
CLOSER_SERVICE_PORT=4042
CLOSER_PUBLIC_BASE_URL=http://127.0.0.1:4042
CLOSER_BROWSER=local            # local | agentcore
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @happy/closer exec vitest run test/service-e2e.test.ts`
Expected: PASS, 1 test

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: everything green, including the pre-existing tests

- [ ] **Step 6: Commit**

```bash
git add packages/closer/src/service/ packages/closer/test/service-e2e.test.ts packages/closer/package.json .env.example
git commit -m "Drive a real browser checkout end to end against a fake Happy

The end-to-end test runs the whole service against apps/demo-store and a fake
Happy that claims, reveals and collects callbacks, on a local browser. No AWS,
no money, and a card that cannot spend.

Submission never waits for a top-level navigation. A gateway's 3DS challenge
is a modal iframe on the same page, so demanding navigation turns every
challenge into a timeout — a cancelled purchase and a card stranded with the
money already gone."
```

---

### Task 9: Stub Happy's scouts to five fixed listings

**Files:**
- Create: `backend/src/providers/stubListings.ts`
- Modify: `backend/src/providers/agent.ts` (use the fixture when `SCOUT_MODE=stub`)
- Test: `backend/src/stubListings.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `STUB_LISTINGS: { title: string; seller: string; rating: string; price: string; amountMinor: number; why: string; url: string }[]`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/stubListings.test.ts
import { describe, expect, it } from "vitest";
import { STUB_LISTINGS } from "./providers/stubListings.js";

describe("stub listings", () => {
  it("offers five listings", () => {
    expect(STUB_LISTINGS).toHaveLength(5);
  });

  it("every listing has an https url and a price inside the card bounds", () => {
    for (const listing of STUB_LISTINGS) {
      expect(new URL(listing.url).protocol).toBe("https:");
      // The StraitsX card only mints between S$5 and S$30.
      expect(listing.amountMinor).toBeGreaterThanOrEqual(500);
      expect(listing.amountMinor).toBeLessThanOrEqual(3000);
    }
  });

  it("states the price consistently with amountMinor", () => {
    for (const listing of STUB_LISTINGS) {
      expect(listing.price).toBe(`S$${(listing.amountMinor / 100).toFixed(2)}`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @happy/backend exec vitest run src/stubListings.test.ts`
Expected: FAIL — cannot resolve `./providers/stubListings.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/providers/stubListings.ts
/**
 * Fixed listings, standing in for discovery.
 *
 * Nylon Coffee because it is the one merchant proven end to end from an AWS datacentre IP: it
 * serves no bot wall, and its Shopify checkout renders card fields from
 * checkout.pci.shopifyinc.com, which the Closer's frame-searching filler reaches. Every price sits
 * inside the S$5–30 the StraitsX card can mint.
 */
export const STUB_LISTINGS = [
  {
    title: "Kenya AB Kiamwangi",
    seller: "Nylon Coffee Roasters",
    rating: "4.8",
    price: "S$23.50",
    amountMinor: 2350,
    why: "Filter roast, matches the specification",
    url: "https://nylon.coffee/products/kenya-ab-kiamwangi",
  },
  {
    title: "Brazil Nossa Senhora Aparecida Espresso",
    seller: "Nylon Coffee Roasters",
    rating: "4.7",
    price: "S$23.50",
    amountMinor: 2350,
    why: "Espresso roast within budget",
    url: "https://nylon.coffee/products/brazil-nossa-senhora-aparecida",
  },
  {
    title: "Colombia El Pinal Espresso",
    seller: "Nylon Coffee Roasters",
    rating: "4.6",
    price: "S$23.50",
    amountMinor: 2350,
    why: "Espresso roast within budget",
    url: "https://nylon.coffee/products/colombia-el-pinal",
  },
  {
    title: "Nylon Filter Papers",
    seller: "Nylon Coffee Roasters",
    rating: "4.5",
    price: "S$6.50",
    amountMinor: 650,
    why: "Cheapest item that still clears the S$5 card floor",
    url: "https://nylon.coffee/products/filter-papers",
  },
  {
    title: "Nylon Coffee Tote",
    seller: "Nylon Coffee Roasters",
    rating: "4.4",
    price: "S$18.00",
    amountMinor: 1800,
    why: "Merchandise, mid-range price",
    url: "https://nylon.coffee/products/tote",
  },
] as const satisfies readonly {
  title: string;
  seller: string;
  rating: string;
  price: string;
  amountMinor: number;
  why: string;
  url: string;
}[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @happy/backend exec vitest run src/stubListings.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/providers/stubListings.ts backend/src/stubListings.test.ts
git commit -m "Stand in for discovery with five fixed listings

Nylon Coffee because it is the one merchant proven end to end from an AWS
datacentre IP — no bot wall, and its Shopify checkout serves card fields from
checkout.pci.shopifyinc.com, which the frame-searching filler reaches. Every
price sits inside the S\$5-30 the StraitsX card can mint."
```

---

### Task 10: Document the service and the wiring

**Files:**
- Create: `packages/closer/SERVICE.md`
- Modify: `docs/agentcore-browser.md` (link the service)

- [ ] **Step 1: Write the document**

Cover, with no placeholders: the two endpoints and their auth; the payload; the callback types and when each fires; the verification gate as a table; the card rules; how `liveStreamUrl` works and why it blanks; `CLOSER_BROWSER=local|agentcore`; how to run it (`pnpm --filter @happy/closer service`); how to point Happy at it (`PURCHASE_AGENT_MODE=remote`, `PURCHASE_AGENT_API_BASE_URL=http://127.0.0.1:4042`, matching `PURCHASE_AGENT_API_TOKEN`); and what remains blocked (StraitsX production whitelisting, the 3DS question).

- [ ] **Step 2: Verify every command in it actually runs**

Run each command block in the document. Fix anything that does not work.

- [ ] **Step 3: Commit**

```bash
git add packages/closer/SERVICE.md docs/agentcore-browser.md
git commit -m "Document the purchase service

Records the wiring on both sides so nobody has to read purchaseAgent.ts to
discover which env vars point Happy at the Closer, and states plainly what is
still blocked: production whitelisting, and whether the card's BIN is
3DS-enrolled."
```

---

## Self-Review

**Spec coverage.** Both endpoints — Task 7. Bearer auth — Task 7. 202 within 15s and persisted idempotency — Tasks 1, 7. Card claimed by the Closer itself, once — Tasks 1, 4, 6. Reveal by the Closer itself — Task 4. Material in memory only, never returned or logged — Tasks 4, 6 (with an explicit test that no callback contains the PAN). Verification gate, every condition — Task 3, enforced in Task 6. No substitution, `purchase.failed` on an over-budget total — Tasks 3, 6. Callbacks with unique-but-stable `eventId`, `attemptId`, `itemId` — Tasks 2, 6. Cancellation — Tasks 1, 6, 7. `liveStreamUrl` and its blanking — Tasks 5, 6. Stubbed discovery — Task 9. Never a top-level navigation after submit — Task 8. Typed, never `fill()` — Task 8.

**Placeholders.** None. Every code step carries the code; every test step carries the test.

**Type consistency.** `PurchaseJobInput` is defined once in Task 3 and imported by Tasks 6, 7, 8. `CardMaterial` is defined in Task 4 and consumed by Tasks 6 and 8. `JobStore` and `LiveView` are defined in Tasks 1 and 5 and consumed by 6 and 7. `PurchaseEvent` types match `PurchaseAgentCallbackEvent` in `backend/src/schemas.ts` exactly, including `orderId` on `order.confirmed` and `retryable` on `purchase.failed`.

**One gap accepted deliberately.** Task 8's `readTotalMinorFrom` reads `[data-total-cents]`, which `apps/demo-store` provides and Nylon Coffee does not. The AgentCore run against a real merchant needs a merchant-specific total reader; that is the existing `MerchantAdapter.readFinalTotalCents` seam, and wiring it is a follow-up rather than part of this plan.
