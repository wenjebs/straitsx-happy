/**
 * The whole service against a fake Happy and apps/demo-store, on a local browser.
 *
 * No AWS, no money, and a card that cannot spend. This is the test that would catch the failures
 * that actually cost something: a card claimed twice, card material reaching a callback, or a
 * checkout reported as confirmed when nothing was bought.
 */
import { serve } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
// The subpath export, not the package root: importing the root starts a listener on :4030.
import { app } from "@happy/demo-store/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPurchaseService } from "../src/service/index.js";

const PAN = "4242424242424242";

let storeUrl = "";
let happyUrl = "";
let serviceUrl = "";
let store: ReturnType<typeof serve>;
let happy: Server;
let service: Server;
const events: Record<string, unknown>[] = [];
let claims = 0;

beforeAll(async () => {
  store = serve({ fetch: app.fetch, port: 0 });
  storeUrl = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;

  // A fake Happy: claim, reveal, and a callback sink.
  happy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";

    if (url.includes("/claim")) {
      claims += 1;
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
        JSON.stringify({ pan: PAN, expiryMonth: "12", expiryYear: "40", cvc: "123" }),
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
  delete process.env.CLOSER_PUBLIC_BASE_URL;
  service = await startPurchaseService(0);
  serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((r) => service.close(() => r()));
  await new Promise<void>((r) => happy.close(() => r()));
  store.close();
});

const job = (over: Record<string, unknown> = {}) => ({
  activityId: "act_e2e",
  attemptId: "attempt_e2e",
  item: { id: "ssd", name: "NVMe SSD" },
  listing: {
    url: `${storeUrl}/item/nvme-ssd`,
    title: "NVMe SSD",
    seller: "demo-store",
    price: "S$29.00",
    amountMinor: 2900,
  },
  cardGrant: {
    claimUrl: `${happyUrl}/claim`,
    token: "grant",
    amountMinor: 2900,
    currency: "SGD",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
  sandbox: true,
  idempotencyKey: "k-e2e",
  amountMinor: 2900,
  callback: { url: `${happyUrl}/events`, token: "cb" },
  ...over,
});

const postJob = (payload: unknown) =>
  fetch(`${serviceUrl}/v1/purchase-runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(payload),
  });

async function settle(predicate: () => boolean, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("purchase service end to end", () => {
  it("buys the listing and reports the full callback sequence", async () => {
    const res = await postJob(job());
    expect(res.status).toBe(202);

    await settle(() => events.some((e) => e.type === "order.confirmed" || e.type === "purchase.failed"));

    const types = events.map((e) => e.type);
    // Surfaces the reason instead of just "expected [...] to include", which is useless here.
    const failed = events.find((e) => e.type === "purchase.failed");
    expect(failed?.message ?? null).toBeNull();
    expect(types).toContain("browser.started");
    expect(types).toContain("checkout.prepared");
    expect(types).toContain("order.placing");
    expect(types).toContain("order.confirmed");

    const confirmed = events.find((e) => e.type === "order.confirmed");
    expect(String(confirmed?.orderId).length).toBeGreaterThan(0);

    // browser.started must carry a live view URL the frontend can actually render.
    const started = events.find((e) => e.type === "browser.started");
    expect(String(started?.liveStreamUrl)).toContain("/v1/live/");
    const view = await fetch(String(started?.liveStreamUrl));
    expect(view.status).toBe(200);

    // The one that matters: card material never reaches Happy.
    expect(JSON.stringify(events)).not.toContain(PAN);
    expect(claims).toBe(1);
  }, 180_000);

  it("starts nothing new for a repeated idempotency key", async () => {
    const before = events.length;
    const res = await postJob(job());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ duplicate: true });
    await new Promise((r) => setTimeout(r, 1500));
    expect(events.length).toBe(before);
    expect(claims).toBe(1);
  }, 60_000);

  it("refuses to buy when the merchant's total exceeds the approved amount", async () => {
    const before = events.length;
    // demo-store shows 2900 for this item; approve less and the gate must fire.
    await postJob(
      job({
        attemptId: "attempt_over",
        idempotencyKey: "k-over",
        amountMinor: 1500,
        listing: {
          url: `${storeUrl}/item/nvme-ssd`,
          title: "NVMe SSD",
          seller: "demo-store",
          price: "S$15.00",
          amountMinor: 1500,
        },
        cardGrant: {
          claimUrl: `${happyUrl}/claim`,
          token: "grant",
          amountMinor: 1500,
          currency: "SGD",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      }),
    );

    await settle(() => events.slice(before).some((e) => e.type === "purchase.failed"));
    const failure = events.slice(before).find((e) => e.type === "purchase.failed");
    expect(String(failure?.message)).toMatch(/exceeds/i);
    // No second claim: the gate fired while failing was still free.
    expect(claims).toBe(1);
  }, 120_000);
});
