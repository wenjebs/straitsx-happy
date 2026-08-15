import { describe, expect, it } from "vitest";
import { createMemoryJournal } from "../src/journal.js";
import { createCloser } from "../src/runner.js";
import type { CloserEvent, MerchantAdapter, PayApi } from "../src/types.js";
import { fakeAdapter, fakeBrowser, fakePay } from "./fakes.js";

const sel = { itemId: "gpu", url: "http://127.0.0.1:4033/item/gpu" };

async function runWith(over: { pay?: Partial<PayApi>; adapter?: MerchantAdapter }) {
  const pay = fakePay(over.pay ?? {});
  const events: CloserEvent[] = [];
  const closer = createCloser({
    browser: fakeBrowser(),
    pay,
    adapters: [over.adapter ?? fakeAdapter()],
    journal: createMemoryJournal(),
    onEvent: (e) => events.push(e),
  });
  const res = await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: [sel] });
  const texts = events.flatMap((e) => (e.type === "log.line" ? [e.line.text] : []));
  return { pay, res, texts };
}

describe("skips before any money moves", () => {
  it("skips an item no adapter claims", async () => {
    const { res, pay } = await runWith({ adapter: { ...fakeAdapter(), matches: () => false } });
    expect(res.items[0]).toMatchObject({ status: "skipped", reason: "NO_ADAPTER" });
    expect(pay.calls).toEqual([]);
  });

  it("retries navigation once, then skips", async () => {
    let tries = 0;
    const adapter = {
      ...fakeAdapter(),
      async toPaymentPage() {
        tries += 1;
        throw new Error("login required");
      },
    };
    const { res, pay } = await runWith({ adapter });
    expect(tries).toBe(2);
    expect(res.items[0]).toMatchObject({ status: "skipped", reason: "PRECHECK_FAILED" });
    expect(pay.calls).toEqual([]);
  });

  it("skips when the total cannot be read as whole cents", async () => {
    const adapter = {
      ...fakeAdapter(),
      async readFinalTotalCents() {
        return 29.5;
      },
    };
    const { res } = await runWith({ adapter });
    expect(res.items[0]).toMatchObject({ status: "skipped", reason: "TOTAL_UNREADABLE" });
  });

  it("skips a S$429 item because the rail cannot mint it", async () => {
    const { res, texts, pay } = await runWith({ adapter: fakeAdapter(42900) });
    expect(res.items[0]).toMatchObject({ status: "skipped", reason: "ABOVE_RAIL_MAXIMUM" });
    expect(texts).toContain("gpu skipped · S$429.00 is over the S$30.00 card ceiling");
    expect(pay.calls).toEqual(["getMandate"]);
  });

  it("skips an item under the S$5 floor", async () => {
    const { res } = await runWith({ adapter: fakeAdapter(300) });
    expect(res.items[0]).toMatchObject({ status: "skipped", reason: "BELOW_RAIL_MINIMUM" });
  });

  it("skips what the mandate denies, quoting its reason", async () => {
    const { res, pay } = await runWith({
      pay: {
        async evaluate() {
          return { decision: "DENY", reason: "MERCHANT_NOT_ALLOWED" };
        },
      },
    });
    expect(res.items[0]).toMatchObject({ status: "skipped", reason: "MERCHANT_NOT_ALLOWED" });
    expect(pay.calls).not.toContain("reserve:pur_1");
  });

  it("skips NEEDS_HUMAN, because no endpoint exists to answer it", async () => {
    const { res, texts } = await runWith({
      pay: {
        async evaluate() {
          return { decision: "NEEDS_HUMAN", reason: "OVER_PER_ITEM_CAP" };
        },
      },
    });
    expect(res.items[0]).toMatchObject({ status: "skipped", reason: "NEEDS_HUMAN" });
    expect(texts.some((t) => t.includes("needs a human"))).toBe(true);
  });

  it("releases the reservation when the total moves past tolerance", async () => {
    let reads = 0;
    const adapter = {
      ...fakeAdapter(),
      async readFinalTotalCents() {
        reads += 1;
        return reads === 1 ? 2900 : 2990; // +3.1%, past the 2% tolerance
      },
    };
    const { res, pay } = await runWith({ adapter });
    expect(res.items[0]).toMatchObject({ status: "skipped", reason: "PRICE_CHANGED" });
    expect(pay.calls).toContain("cancel:pur_1");
    expect(pay.calls).not.toContain("issueCard:pur_1");
    expect(pay.states.get("pur_1")).toBe("RELEASED");
  });

  it("issues against the re-read total when it moves within tolerance", async () => {
    let reads = 0;
    const adapter = {
      ...fakeAdapter(),
      async readFinalTotalCents() {
        reads += 1;
        return reads === 1 ? 2900 : 2950; // +1.7%, inside tolerance — shipping settled
      },
    };
    const { res } = await runWith({ adapter });
    expect(res.items[0]).toMatchObject({ status: "purchased", amountMinor: 2950 });
  });
});
