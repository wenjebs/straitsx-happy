import { describe, expect, it } from "vitest";
import { createMemoryJournal } from "../src/journal.js";
import { type CloserDeps, createCloser } from "../src/runner.js";
import type { CloserEvent } from "../src/types.js";
import { fakeAdapter, fakeBrowser, fakePay } from "./fakes.js";

const selection = {
  itemId: "ssd",
  tag: "SSD",
  hueIndex: 2,
  url: "http://127.0.0.1:4033/item/nvme-ssd",
};

function harness(over: Partial<CloserDeps> = {}) {
  const pay = fakePay();
  const events: CloserEvent[] = [];
  const closer = createCloser({
    browser: fakeBrowser(),
    pay,
    adapters: [fakeAdapter()],
    journal: createMemoryJournal(),
    onEvent: (e) => events.push(e),
    now: () => Date.parse("2026-08-15T06:41:02Z"),
    ...over,
  });
  return { pay, events, closer };
}

const texts = (events: CloserEvent[]) =>
  events.flatMap((e) => (e.type === "log.line" ? [e.line.text] : []));
const steps = (events: CloserEvent[]) =>
  events.flatMap((e) => (e.type === "exec.step" ? [e.row.step] : []));

describe("the happy path", () => {
  it("reserves, issues, pays and completes — in that order", async () => {
    const { pay, closer } = harness();
    await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: [selection] });
    expect(pay.calls).toEqual([
      "getMandate",
      "evaluate",
      "reserve:pur_1",
      "issueCard:pur_1",
      "payWithCard",
      "complete:pur_1",
    ]);
  });

  it("emits one exec.step per real step, 0 through 4", async () => {
    const { events, closer } = harness();
    await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: [selection] });
    expect(steps(events)).toEqual([0, 1, 2, 3, 4]);
  });

  it("writes log lines a human can read", async () => {
    const { events, closer } = harness();
    await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: [selection] });
    expect(texts(events)).toEqual([
      "127.0.0.1/checkout · total S$29.00",
      "card •••• 4402 issued · limit S$29.00",
      "127.0.0.1/checkout · placing order S$29.00",
      "order #ord_a1b2 confirmed · card spent",
    ]);
  });

  it("reports the purchase and the money that left the wallet", async () => {
    const { closer, events } = harness();
    const res = await closer.run({
      activityId: "act_1",
      idempotencyKey: "k1",
      selections: [selection],
    });
    expect(res.items).toEqual([
      {
        itemId: "ssd",
        status: "purchased",
        purchaseId: "pur_1",
        orderRef: "ord_a1b2",
        amountMinor: 2900,
        last4: "4402",
      },
    ]);
    expect(res.totalMinor).toBe(2900);
    expect(res.aborted).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", totalMinor: 2900 });
  });

  it("never puts card material in the result", async () => {
    const { closer } = harness();
    const res = await closer.run({
      activityId: "act_1",
      idempotencyKey: "k1",
      selections: [selection],
    });
    const json = JSON.stringify(res).toLowerCase();
    expect(json).not.toMatch(/\b\d{13,19}\b/);
    expect(json).not.toContain("cvc");
  });
});
