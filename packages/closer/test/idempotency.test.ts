import { describe, expect, it } from "vitest";
import { createMemoryJournal } from "../src/journal.js";
import { createCloser } from "../src/runner.js";
import { fakeAdapter, fakeBrowser, fakePay } from "./fakes.js";

const sel = [{ itemId: "ssd", url: "http://127.0.0.1:4033/item/nvme-ssd" }];

function harness(journal = createMemoryJournal(), pay = fakePay()) {
  const closer = createCloser({
    browser: fakeBrowser(),
    pay,
    adapters: [fakeAdapter()],
    journal,
    onEvent: () => {},
  });
  return { closer, pay, journal };
}

describe("idempotency", () => {
  it("replays the stored result for a repeat of the same key, buying nothing", async () => {
    const { closer, pay } = harness();
    const first = await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: sel });
    const before = pay.calls.length;
    const again = await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: sel });
    expect(again).toEqual(first);
    expect(pay.calls.length).toBe(before);
  });

  it("refuses a different key on an activity that already ran", async () => {
    const { closer } = harness();
    await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: sel });
    await expect(
      closer.run({ activityId: "act_1", idempotencyKey: "k2", selections: sel }),
    ).rejects.toThrow(/already been purchased/);
  });

  it("returns the same promise while a run is in flight", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pay = fakePay({
      async payWithCard() {
        await gate;
        return { ok: true, orderRef: "ord_a1b2" };
      },
    });
    const { closer } = harness(createMemoryJournal(), pay);
    const a = closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: sel });
    const b = closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: sel });
    release();
    expect(await a).toEqual(await b);
    expect(pay.calls.filter((c) => c.startsWith("reserve")).length).toBe(1);
  });

  it("refuses to re-run an activity whose journal is stuck at issuing", async () => {
    const journal = createMemoryJournal();
    journal.write({
      activityId: "act_1",
      idempotencyKey: "k1",
      startedAt: "2026-08-15T06:41:02.000Z",
      state: "running",
      items: [{ itemId: "ssd", state: "issuing", purchaseId: "pur_1" }],
      result: null,
    });
    const { closer } = harness(journal);
    await expect(
      closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: sel }),
    ).rejects.toThrow(/unfinished run/);
  });
});
