import { describe, expect, it } from "vitest";
import { hhmmss, makeLogger, mask, sgd } from "../src/format.js";
import type { CloserEvent } from "../src/types.js";

describe("format", () => {
  it("renders cents as two-decimal SGD, matching the contract's log examples", () => {
    expect(sgd(2900)).toBe("S$29.00");
    expect(sgd(3000)).toBe("S$30.00");
    expect(sgd(42900)).toBe("S$429.00");
  });

  it("masks to the last four — a full PAN is never available to mask", () => {
    expect(mask("4402")).toBe("•••• 4402");
    expect(mask(null)).toBe("•••• ????");
  });

  it("stamps HH:MM:SS", () => {
    expect(hhmmss(Date.parse("2026-08-15T06:41:02Z"))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("numbers log lines monotonically within an activity", () => {
    const seen: CloserEvent[] = [];
    const log = makeLogger(
      "act_1",
      (e) => seen.push(e),
      () => 0,
    );
    log("SSD", 2, "hello");
    log("SYS", 0, "world");
    expect(seen.map((e) => (e.type === "log.line" ? e.line.id : ""))).toEqual([
      "l_act_1_1",
      "l_act_1_2",
    ]);
    expect(seen[1]).toMatchObject({
      type: "log.line",
      line: { tag: "SYS", hueIndex: 0, text: "world" },
    });
  });
});
