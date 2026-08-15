import type { ArchiveId, ItemId } from "../data/catalog";

export type Screen = "purchase" | "wallet" | "mandate" | "settings" | "profile";

/** Stage of the running activity. In production this is derived from the record. */
export type Stage = "idle" | "wishlist" | "curate" | "search" | "shortlist" | "exec";

/** null = feed visible; "current" = the running activity; otherwise an archive id. */
export type Focused = null | "current" | ArchiveId;

export type RuleState = "allowed" | "ask first" | "blocked";

/**
 * A conversation entry. Modelled as a discriminated union rather than the
 * prototype's boolean flags so the renderer can exhaustively switch.
 */
export type Message =
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string; label: string }
  | { kind: "wishlist"; text: string }
  | { kind: "curator"; text: string; itemId: ItemId }
  | { kind: "locked"; text: string };

export interface LogLine {
  ts: string;
  short: string;
  hue: string;
  text: string;
}

export interface HappyState {
  screen: Screen;
  stage: Stage;
  sidebarOpen: boolean;
  draft: string;
  msgs: Message[];
  editing: boolean;
  newItem: string;
  removed: Partial<Record<ItemId, true>>;
  chosen: Partial<Record<ItemId, string>>;
  rejected: Partial<Record<ItemId, true>>;
  /** Search timer count. Drives every item's stage. Server events in production. */
  tick: number;
  playing: boolean;
  execStep: number;
  log: LogLine[];
  balance: number;
  toast: string;
  autoApprove: boolean;
  itemCap: number;
  actCap: number;
  ruleState: Record<string, RuleState>;
  settingsState: { notify: boolean; sandbox: boolean };
  activityLive: boolean;
  activityDone: boolean;
  focused: Focused;
  /** Stash for the running activity while it is unfocused. */
  actStage: Stage;
  actMsgs: Message[];
}
