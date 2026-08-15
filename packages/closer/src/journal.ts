import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "./types.js";

export type JournalItemState =
  | "reserving"
  | "reserved"
  | "issuing"
  | "done"
  | "stranded"
  | "unknown"
  | "skipped";

export type JournalItem = {
  itemId: string;
  state: JournalItemState;
  purchaseId?: string;
  amountMinor?: number;
  orderRef?: string | null;
  reason?: string;
};

export type JournalRecord = {
  activityId: string;
  idempotencyKey: string;
  startedAt: string;
  state: "running" | "finished" | "aborted";
  items: JournalItem[];
  result: RunResult | null;
};

export interface Journal {
  read(activityId: string): JournalRecord | null;
  write(rec: JournalRecord): void;
}

/** Holds no card material — item ids, purchase ids, states, order refs. 0600 anyway. */
export function createFileJournal(
  dir: string = process.env.CLOSER_JOURNAL_DIR ?? "./closer-runs",
): Journal {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = (id: string) => join(dir, `${encodeURIComponent(id)}.json`);
  return {
    read(activityId) {
      let raw: string;
      try {
        raw = readFileSync(path(activityId), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
      // A corrupt journal must throw. Swallowing it here would let a crashed run be replayed
      // from scratch, and a replay past issuance mints a second card for the same item.
      return JSON.parse(raw) as JournalRecord;
    },
    write(rec) {
      const target = path(rec.activityId);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
      renameSync(tmp, target); // atomic — a torn journal can never be read
    },
  };
}

export function createMemoryJournal(): Journal {
  const byId = new Map<string, string>();
  return {
    read: (id) => (byId.has(id) ? (JSON.parse(byId.get(id) as string) as JournalRecord) : null),
    write: (rec) => void byId.set(rec.activityId, JSON.stringify(rec)),
  };
}
