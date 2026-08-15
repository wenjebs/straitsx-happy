import type { Activity, ConnectionState, Mandate, Profile, Settings, Wallet } from "../lib/Api";

export type Screen = "purchase" | "wallet" | "mandate" | "settings" | "profile";

/** null = new-chat/activity-list page; otherwise the displayed activity id. */
export type Focused = string | null;

/**
 * Everything the shell renders. Server-backed fields mirror what Api.ts
 * returned or what the event stream last reported; the rest is local view
 * state that never round-trips.
 */
export interface HappyState {
  // -- local view state
  screen: Screen;
  sidebarOpen: boolean;
  focused: Focused;
  draft: string;
  newItem: string;
  editing: boolean;
  /** Guards the irreversible purchase call behind an explicit confirmation. */
  confirmingPurchase: boolean;
  /** Set while a spend call is in flight, so it cannot be submitted twice. */
  purchaseSubmitting: boolean;
  /** Seconds since agents were dispatched, for the "t+42s" counter. */
  elapsed: number;

  // -- server-backed
  /** All live and historical activities, newest first. */
  activities: Activity[];
  /** The selected live activity. Other live activities continue in activities. */
  running: Activity | null;
  viewingArchive: Activity | null;
  wallet: Wallet | null;
  mandate: Mandate | null;
  settings: Settings | null;
  profile: Profile | null;

  connection: ConnectionState;
  /** Last transport or API failure, surfaced without tearing down the view. */
  error: string | null;
  /** True until the first load settles, so screens can hold their shape. */
  loading: boolean;
}
