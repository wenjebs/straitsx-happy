import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPurchaseServer } from "../src/service/server.js";
import type { PurchaseJobInput } from "../src/service/verify.js";

const startRun = vi.fn<(job: PurchaseJobInput) => void>();
const server = createPurchaseServer({ token: "secret", startRun });
let base = "";

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

const post = (path: string, payload: unknown, token: string | null = "secret") =>
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
  it("rejects a missing or wrong token with 401 and starts nothing", async () => {
    startRun.mockClear();
    expect((await post("/v1/purchase-runs", body(), null)).status).toBe(401);
    expect((await post("/v1/purchase-runs", body(), "nope")).status).toBe(401);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("accepts a valid job with 202 and starts exactly one run", async () => {
    startRun.mockClear();
    const res = await post("/v1/purchase-runs", body({ idempotencyKey: "kA" }));
    expect(res.status).toBe(202);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a repeat key answers 202 and starts nothing new", async () => {
    startRun.mockClear();
    await post("/v1/purchase-runs", body({ idempotencyKey: "kB" }));
    const again = await post("/v1/purchase-runs", body({ idempotencyKey: "kB" }));
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed body with 400", async () => {
    expect((await post("/v1/purchase-runs", { activityId: "act_1" })).status).toBe(400);
  });

  it("acknowledges a cancel with 200, even for an unknown attempt", async () => {
    const res = await post("/v1/purchase-runs/act_zzz/cancel", {
      attemptId: "attempt_zzz",
      reason: "user cancelled",
    });
    expect(res.status).toBe(200);
  });

  // An iframe cannot send a bearer token, so the live view must be reachable without one.
  it("serves the live view page unauthenticated", async () => {
    const res = await fetch(`${base}/v1/live/attempt_1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<canvas");
  });
});
