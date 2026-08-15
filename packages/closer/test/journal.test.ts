import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileJournal, type JournalRecord } from "../src/journal.js";

const rec = (over: Partial<JournalRecord> = {}): JournalRecord => ({
  activityId: "act_1",
  idempotencyKey: "k1",
  startedAt: "2026-08-15T06:41:02.000Z",
  state: "running",
  items: [],
  result: null,
  ...over,
});

describe("file journal", () => {
  it("returns null for an activity it has never seen", () => {
    const j = createFileJournal(mkdtempSync(join(tmpdir(), "closer-")));
    expect(j.read("act_missing")).toBeNull();
  });

  it("round-trips a record", () => {
    const j = createFileJournal(mkdtempSync(join(tmpdir(), "closer-")));
    j.write(rec({ items: [{ itemId: "ssd", state: "issuing", purchaseId: "pur_1" }] }));
    expect(j.read("act_1")).toMatchObject({
      idempotencyKey: "k1",
      items: [{ itemId: "ssd", state: "issuing", purchaseId: "pur_1" }],
    });
  });

  it("writes owner-only and leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "closer-"));
    createFileJournal(dir).write(rec());
    expect(statSync(join(dir, "act_1.json")).mode & 0o777).toBe(0o600);
    expect(() => readFileSync(join(dir, "act_1.json.tmp"))).toThrow();
  });

  it("throws on a corrupt journal rather than allowing a re-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "closer-"));
    writeFileSync(join(dir, "act_1.json"), "{ not json");
    expect(() => createFileJournal(dir).read("act_1")).toThrow();
  });
});
