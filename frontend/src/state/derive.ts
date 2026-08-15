import type { Activity, ActivityStage, ItemProgress, StageIndex } from "../lib/Api";

/** Identity hue for an item, by palette index. Six before recycling. */
export function hue(index: number): string {
  return `var(--hue-${((index % 6) + 6) % 6})`;
}

/** Minor units (SGD cents) to a display string. */
export function formatMinor(minor: number): string {
  return `S$${(minor / 100).toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function progressFor(activity: Activity | null, itemId: string): ItemProgress | undefined {
  return activity?.itemProgress.find((p) => p.itemId === itemId);
}

/**
 * True when this item's last move was to an earlier stage. Drives the slower
 * overshoot curve and the glow ring — the one thing on the search screen that
 * must never be inferred from a clock, only from what the agent actually did.
 */
export function movedBackward(progress: ItemProgress | undefined): boolean {
  return !!progress && !progress.queued && progress.stage < progress.previousStage;
}

export function executionFor(activity: Activity | null, itemId: string) {
  return activity?.execution.find((r) => r.itemId === itemId);
}

export function agentsFor(activity: Activity | null, itemId: string) {
  return (activity?.agents ?? []).filter((a) => a.itemId === itemId);
}

const FLOW_INDEX: Record<ActivityStage, number> = {
  idle: 0,
  wishlist: 0,
  curate: 1,
  search: 2,
  shortlist: 3,
  exec: 4,
};

/** How far through the current stage the activity is, 0-1. */
function intraStage(activity: Activity): number {
  if (activity.stage === "search") {
    const stages = activity.itemProgress.map((p) => p.stage / 4);
    return stages.length ? Math.max(...stages) : 0;
  }
  if (activity.stage === "exec") {
    if (activity.status === "completed") return 1;
    const total = activity.execution.length * 4;
    if (total === 0) return 0;
    const done = activity.execution.reduce((sum, r) => sum + r.step, 0);
    return Math.min(1, done / total);
  }
  return 0.5;
}

/** Fraction feeding an activity feed card's 26-chevron bar. */
export function flowFraction(activity: Activity | null): number {
  if (!activity) return 0;
  if (activity.status === "completed") return 1;
  if (activity.status === "cancelled") return 0.45;
  if (activity.stage === "idle") return 0;
  return (FLOW_INDEX[activity.stage] + intraStage(activity)) / 5;
}

/**
 * The five stage-bar groups. `matches` exists because clarification has no
 * group of its own — without it the bar empties when the flow moves from the
 * wishlist to the curator, which reads as a glitch.
 */
export const STAGE_GROUPS = [
  { name: "chat", target: "idle", matches: ["idle"] },
  { name: "list", target: "wishlist", matches: ["wishlist", "curate"] },
  { name: "search", target: "search", matches: ["search"] },
  { name: "pick", target: "shortlist", matches: ["shortlist"] },
  { name: "buy", target: "exec", matches: ["exec"] },
] as const satisfies readonly {
  name: string;
  target: ActivityStage;
  matches: readonly ActivityStage[];
}[];

export function stageBarFraction(activity: Activity | null): number {
  if (!activity || activity.stage === "idle") return 0;
  const gi = STAGE_GROUPS.findIndex((g) =>
    (g.matches as readonly ActivityStage[]).includes(activity.stage),
  );
  if (gi < 0) return 0;
  const partial =
    activity.stage === "search" || activity.stage === "exec" ? intraStage(activity) : 1;
  return (gi + partial) / 5;
}

/**
 * Chevron fill colours. Warm ramp — amber at the left through orange to red at
 * the right — with unfilled chevrons gray.
 */
export function chevronColors(frac: number, count: number, mode?: "cancelled"): string[] {
  const filled = Math.round(frac * count);
  return Array.from({ length: count }, (_, i) => {
    if (i >= filled) return "var(--chevron-empty)";
    if (mode === "cancelled") return "var(--chevron-cancelled)";
    const t = count > 1 ? i / (count - 1) : 0;
    return `oklch(0.70 0.175 ${(88 - 62 * t).toFixed(1)})`;
  });
}

/** Feed card copy, derived from the activity's own stage — never from the view. */
export function statusLabels(activity: Activity): { chip: string; bar: string } {
  if (activity.status === "completed") return { chip: "completed", bar: "complete" };
  if (activity.status === "cancelled") return { chip: "cancelled", bar: "stopped at shortlist" };
  switch (activity.stage) {
    case "search":
      return { chip: "searching", bar: "searching…" };
    case "shortlist":
      return { chip: "awaiting you", bar: "awaiting you…" };
    case "exec":
      return { chip: "purchasing", bar: "purchasing…" };
    default:
      return { chip: "drafting", bar: "drafting…" };
  }
}

export const STAGE_LABELS = [
  "Discovering",
  "Analyzing",
  "Gathering",
  "Comparing",
  "Selected",
] as const;

export function stageLabel(stage: StageIndex): string {
  return STAGE_LABELS[stage];
}
