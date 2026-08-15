import type { CloserEvent } from "./types.js";

/** Always two decimals: BACKEND_CONTRACT.md's log examples read "S$429.00", not "S$429".
 *  (@happy/pay's mandate footer drops a trailing .00 — different surface, different rule.) */
export const sgd = (cents: number) => `S$${(cents / 100).toFixed(2)}`;

/** The Closer never sees a PAN. @happy/pay returns last4 and nothing else, by design. */
export const mask = (last4: string | null) => `•••• ${last4 ?? "????"}`;

export const hhmmss = (at: number) => new Date(at).toTimeString().slice(0, 8);

export function makeLogger(activityId: string, emit: (e: CloserEvent) => void, now: () => number) {
  let seq = 0;
  return (tag: string, hueIndex: number, text: string) => {
    seq += 1;
    emit({
      type: "log.line",
      line: { id: `l_${activityId}_${seq}`, ts: hhmmss(now()), tag, hueIndex, text },
    });
  };
}
