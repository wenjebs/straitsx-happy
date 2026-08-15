import type { Activity, ConnectionState, Mandate, Profile, Settings, Wallet } from "../lib/Api";

export type Screen = "purchase" | "wallet" | "mandate" | "settings" | "profile";

/** null = feed visible; "current" = the running activity; otherwise an archive id. */
export type Focused = null | "current" | string;

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
  /**
   * True after Back, or before anything has been sent: the main column shows
   * the empty chat even though an activity may still be running in the
   * background. Purely a view concern — the activity itself is untouched.
   */
  detached: boolean;
  /** Guards the irreversible purchase call behind an explicit confirmation. */
  confirmingPurchase: boolean;
  /** Set while a spend call is in flight, so it cannot be submitted twice. */
  purchaseSubmitting: boolean;
  /** Seconds since agents were dispatched, for the "t+42s" counter. */
  elapsed: number;

  // -- server-backed
  running: Activity | null;
  archived: Activity[];
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
