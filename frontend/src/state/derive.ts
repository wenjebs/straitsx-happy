import {
  ALTERNATES,
  ITEMS,
  type Item,
  type ItemId,
  LISTINGS,
  type Listing,
  type StageIndex,
} from "../data/catalog";
import type { HappyState, Stage } from "./types";

/** Where an item sits on the track, and whether it just moved backward. */
export interface ItemPosition {
  stage: StageIndex;
  /** True when this tick moved the item to an earlier stage — drives the glow. */
  back: boolean;
  /** True before this item's agents are dispatched. */
  waiting: boolean;
}

export function itemPosition(item: Item, tick: number): ItemPosition {
  const last = item.path.length - 1;
  const c = Math.max(0, Math.min(last, tick - item.start));
  const cur = (item.path[c] ?? 0) as StageIndex;
  const prev = c > 0 ? (item.path[c - 1] ?? cur) : cur;
  return { stage: cur, back: cur < prev, waiting: tick < item.start };
}

export function activeItems(state: HappyState): Item[] {
  return ITEMS.filter((i) => !state.removed[i.id]);
}

/** A rejected pick swaps in its alternate, if one exists. */
export function listingFor(state: HappyState, id: ItemId): Listing {
  const alt = ALTERNATES[id];
  return state.rejected[id] && alt ? alt : LISTINGS[id];
}

export function shortlistTotal(state: HappyState): number {
  return activeItems(state).reduce((sum, i) => sum + listingFor(state, i.id).amount, 0);
}

/** Every item has reached the end of its authored path. */
export function searchComplete(state: HappyState): boolean {
  return activeItems(state).every((i) => state.tick - i.start >= i.path.length - 1);
}

/**
 * The stage the running activity is actually at, which survives leaving the
 * screen. The feed chip and its chevron fraction must both come from this —
 * never from the displayed view, or a card can read "drafting" while its bar
 * shows search progress.
 */
export function effectiveStage(state: HappyState): Stage {
  return state.stage !== "idle" ? state.stage : state.actStage;
}

const FLOW_INDEX: Record<Stage, number> = {
  idle: 0,
  wishlist: 0,
  curate: 1,
  search: 2,
  shortlist: 3,
  exec: 4,
};

/** How far through the current stage we are, 0–1. */
function intraStage(state: HappyState, stage: Stage): number {
  if (stage === "search") {
    return Math.max(
      ...activeItems(state).map((i) => {
        const last = i.path.length - 1;
        return last > 0 ? Math.max(0, Math.min(last, state.tick - i.start)) / last : 1;
      }),
    );
  }
  if (stage === "exec") {
    if (state.activityDone) return 1;
    const total = activeItems(state).length * 4;
    return total > 0 ? Math.min(1, state.execStep / total) : 0;
  }
  return 0.5;
}

/** Fraction feeding the activity feed card's 26-chevron bar. */
export function flowFraction(state: HappyState): number {
  if (state.activityDone) return 1;
  if (!state.activityLive) return 0;
  const stage = effectiveStage(state);
  return (FLOW_INDEX[stage] + intraStage(state, stage)) / 5;
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
] as const satisfies readonly { name: string; target: Stage; matches: readonly Stage[] }[];

/** Fraction feeding the stage bar's 5 groups of 8 chevrons. */
export function stageBarFraction(state: HappyState): number {
  if (state.stage === "idle") return 0;
  const gi = STAGE_GROUPS.findIndex((g) => (g.matches as readonly Stage[]).includes(state.stage));
  if (gi < 0) return 0;
  const partial =
    state.stage === "search" || state.stage === "exec" ? intraStage(state, state.stage) : 1;
  return (gi + partial) / 5;
}

/**
 * Chevron fill colours for a bar. Warm ramp — amber at the left through orange
 * to red at the right — with unfilled chevrons gray.
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

/** Agent log timestamps start at 14:32:08 and advance 3s per line. */
export function logStamp(n: number): string {
  const base = 14 * 3600 + 32 * 60 + 8 + n * 3;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(Math.floor(base / 3600))}:${pad(Math.floor((base % 3600) / 60))}:${pad(base % 60)}`;
}
