import { describe, expect, it } from "vitest";
import { createMemoryJournal } from "../src/journal.js";
import { createCloser } from "../src/runner.js";
import type { CloserEvent, PayApi } from "../src/types.js";
import { fakeAdapter, fakeBrowser, fakePay } from "./fakes.js";

const sel = { itemId: "ssd", url: "http://127.0.0.1:4033/item/nvme-ssd" };

async function runWith(over: Partial<PayApi>) {
  const pay = fakePay(over);
  const events: CloserEvent[] = [];
  const closer = createCloser({
    browser: fakeBrowser(),
    pay,
    adapters: [fakeAdapter()],
    journal: createMemoryJournal(),
    onEvent: (e) => events.push(e),
  });
  const res = await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: [sel] });
  return { pay, res, texts: events.flatMap((e) => (e.type === "log.line" ? [e.line.text] : [])) };
}

describe("after the card exists", () => {
  it("strands the purchase when the merchant declines", async () => {
    const { res, pay, texts } = await runWith({
      async payWithCard() {
        return { ok: false, error: "DECLINED" };
      },
    });
    expect(res.items[0]).toMatchObject({
      status: "stranded",
      reason: "DECLINED",
      amountMinor: 2900,
    });
    expect(pay.states.get("pur_1")).toBe("STRANDED");
    expect(pay.calls).not.toContain("complete:pur_1"); // a purchase that never charged is not DONE
    expect(res.totalMinor).toBe(2900); // the money left the wallet; the total must say so
    expect(texts).toContain("S$29.00 spent · no order confirmation · card •••• 4402 stranded");
  });

  it("strands on a timeout, because nothing could confirm the order", async () => {
    const { res, pay } = await runWith({
      async payWithCard() {
        return { ok: false, error: "TIMEOUT" };
      },
    });
    expect(res.items[0]).toMatchObject({ status: "stranded", reason: "TIMEOUT" });
    expect(pay.calls).not.toContain("complete:pur_1");
  });

  it("strands rather than crashing when payWithCard throws", async () => {
    const { res, pay } = await runWith({
      async payWithCard() {
        throw new Error("browser closed");
      },
    });
    expect(res.items[0]).toMatchObject({ status: "stranded", reason: "CHECKOUT_THREW" });
    expect(pay.states.get("pur_1")).toBe("STRANDED");
  });
});
