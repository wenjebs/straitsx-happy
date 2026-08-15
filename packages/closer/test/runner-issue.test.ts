import { describe, expect, it } from "vitest";
import { createMemoryJournal } from "../src/journal.js";
import { createCloser } from "../src/runner.js";
import type { CloserEvent } from "../src/types.js";
import { fakeAdapter, fakeBrowser, fakePay } from "./fakes.js";

const two = [
  { itemId: "ssd", url: "http://127.0.0.1:4033/item/nvme-ssd" },
  { itemId: "hub", url: "http://127.0.0.1:4033/item/usb-c-hub" },
];

function harness(pay = fakePay()) {
  const events: CloserEvent[] = [];
  const closer = createCloser({
    browser: fakeBrowser(),
    pay,
    adapters: [fakeAdapter()],
    journal: createMemoryJournal(),
    onEvent: (e) => events.push(e),
  });
  return {
    pay,
    events,
    closer,
    texts: () => events.flatMap((e) => (e.type === "log.line" ? [e.line.text] : [])),
  };
}

describe("when issueCard throws", () => {
  it("releases and carries on when nothing was transmitted", async () => {
    const pay: ReturnType<typeof fakePay> = fakePay({
      async issueCard(id, cents) {
        // Only the first item is refused, so the test can also show the run carrying on.
        if (id === "pur_1") throw new Error("mandate: OVER_DAILY_CAP"); // decide(), before markPaying
        pay.calls.push(`issueCard:${id}`);
        pay.states.set(id, "CARD_ISSUED");
        return { last4: "4402", expiresAt: null, settlementTx: null, cents };
      },
    });
    const { closer } = harness(pay);
    const res = await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: two });
    expect(res.items[0]).toMatchObject({ status: "skipped", reason: "ISSUE_REFUSED" });
    expect(pay.states.get("pur_1")).toBe("RELEASED");
    expect(res.items[1]).toMatchObject({ status: "purchased" }); // the run continues
    expect(res.aborted).toBe(false);
  });

  it("never touches a PAYING purchase, and stops the run", async () => {
    const pay = fakePay({
      async issueCard(id) {
        pay.states.set(id, "PAYING"); // written before send(); the response never came back
        pay.calls.push(`issueCard:${id}`);
        throw new Error("socket hang up");
      },
    });
    const { closer, texts } = harness(pay);
    const res = await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: two });

    expect(pay.calls).not.toContain("cancel:pur_1"); // invariant 4: PAYING is untouchable
    expect(res.items[0]).toMatchObject({ status: "unknown", reason: "SETTLEMENT_UNKNOWN" });
    expect(res.items[1]).toMatchObject({ status: "skipped", reason: "RUN_ABORTED" });
    expect(res.aborted).toBe(true);
    expect(texts().some((t) => t.includes("settlement outcome unknown"))).toBe(true);
  });

  it("goes on to check out when a card exists despite the throw", async () => {
    const pay = fakePay({
      async issueCard(id) {
        pay.states.set(id, "CARD_ISSUED");
        pay.calls.push(`issueCard:${id}`);
        throw new Error("response parse failed after settlement");
      },
    });
    const { closer } = harness(pay);
    const res = await closer.run({
      activityId: "act_1",
      idempotencyKey: "k1",
      selections: [{ itemId: "ssd", url: "http://127.0.0.1:4033/item/nvme-ssd" }],
    });
    expect(pay.calls).toContain("payWithCard");
    expect(res.items[0]).toMatchObject({ status: "purchased", last4: null });
  });

  it("records an outcome instead of poisoning the journal when the runner itself throws", async () => {
    const events: CloserEvent[] = [];
    const journal = createMemoryJournal();
    const closer = createCloser({
      browser: fakeBrowser(),
      pay: fakePay(),
      adapters: [
        {
          ...fakeAdapter(),
          matches() {
            throw new Error("bad adapter");
          },
        },
      ],
      journal,
      onEvent: (e) => events.push(e),
    });
    const res = await closer.run({ activityId: "act_1", idempotencyKey: "k1", selections: two });

    expect(res.items[0]).toMatchObject({ status: "unknown", reason: "RUNNER_ERROR" });
    expect(res.aborted).toBe(true);
    // A journal left at "running" would block every future run of this activity.
    expect(journal.read("act_1")?.state).toBe("aborted");
  });
});
