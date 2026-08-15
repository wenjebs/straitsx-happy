/*
 * Every call the UI makes to the backend, and the switch between the real API
 * and the in-browser mock.
 *
 *   VITE_API_BASE_URL set    -> live HTTP + SSE against that origin
 *   VITE_API_BASE_URL unset  -> lib/mockBackend.ts, entirely in the browser
 *
 * Both modes return the same shapes and emit the same event stream, so the UI
 * runs identical code either way. That is deliberate: it means live mode is not
 * a second, less-exercised path that only gets tested the day it is switched on.
 *
 * The wire contract these functions assume is written out in full in
 * ../BACKEND_CONTRACT.md. Change one, change the other.
 */

import { mockBackend } from "./mockBackend";

export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

/** True when a backend origin is configured. */
export function isLive(): boolean {
  return API_BASE_URL.length > 0;
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * Stage vocabulary is shared verbatim between client and server — no mapping
 * layer, because a mapping layer is where these two drift apart.
 */
export type ActivityStage = "idle" | "wishlist" | "curate" | "search" | "shortlist" | "exec";

export type ActivityStatus = "draft" | "live" | "completed" | "cancelled";

/** 0-4, indexing the five track stops: Discovering..Selected. */
export type StageIndex = 0 | 1 | 2 | 3 | 4;

export interface WishlistItem {
  id: string;
  name: string;
  /** Short uppercase tag used on the track, log and shortlist: GPU, CPU, ... */
  short: string;
  spec: string;
  /** Preformatted for display, e.g. "S$430". */
  budget: string;
  /** 0-5. Index into the six-hue identity palette; the client owns the colours. */
  hueIndex: number;
}

export interface CuratorOption {
  name: string;
  range: string;
  why: string;
  imgLabel: string;
  imageUrl?: string;
}

export interface Clarification {
  itemId: string;
  prompt: string;
  options: CuratorOption[];
  /** Option name once locked. */
  chosen?: string;
}

export interface Listing {
  title: string;
  seller: string;
  rating: string;
  /** Preformatted, e.g. "S$429.00". */
  price: string;
  /** Minor units (SGD cents). Totals are summed from this, never from `price`. */
  amountMinor: number;
  why: string;
  imageUrl?: string;
}

export interface ShortlistPick {
  itemId: string;
  listing: Listing;
  /** True once the pick was rejected and the alternate swapped in. */
  reSearched: boolean;
}

/** Where an item sits on the collective progress track. */
export interface ItemProgress {
  itemId: string;
  stage: StageIndex;
  /**
   * The stage it came from. The client renders backward movement
   * (`stage < previousStage`) with a slower overshoot curve and a glow ring, so
   * this field is what makes the signature animation work. Send it on every
   * update, and set it equal to `stage` when there was no movement.
   */
  previousStage: StageIndex;
  /** True before this item's agents are dispatched. */
  queued: boolean;
}

export interface AgentState {
  agentId: string;
  itemId: string;
  /** 0 is the lead agent, 1 trails it. Two per item. */
  slot: number;
  url: string;
  stage: StageIndex;
  action: string;
  queued: boolean;
  /** Embeddable live browser stream supplied by the remote Scout service. */
  liveStreamUrl?: string;
}

export interface ExecutionRow {
  itemId: string;
  /** 0 queued, 1-3 in flight, 4 purchased. */
  step: number;
  state: "queued" | "live" | "purchased";
}

export interface LogLine {
  id: string;
  /** "HH:MM:SS". */
  ts: string;
  /** Item short tag, or "SYS". */
  tag: string;
  hueIndex: number;
  text: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Drives which in-chat card renders beneath the text. */
  card?: "thinking" | "wishlist" | "curator" | "locked";
  thinkingLabel?: string;
  /** Set when card is "curator". */
  itemId?: string;
}

export interface Activity {
  id: string;
  title: string;
  stage: ActivityStage;
  status: ActivityStatus;
  /** ISO 8601. */
  createdAt: string;
  completedAt?: string;
  /** Display timestamp for the feed card, e.g. "now", "14:41", "Aug 12". */
  displayTs: string;
  messages: Message[];
  wishlist: WishlistItem[];
  /** Preformatted estimate for the wishlist card header, e.g. "est. S$1,285". */
  wishlistEstimate: string;
  clarifications: Clarification[];
  itemProgress: ItemProgress[];
  agents: AgentState[];
  searchPlaying: boolean;
  /** ISO 8601, set when agents are dispatched. Drives the "t+42s" counter. */
  searchStartedAt?: string;
  shortlist: ShortlistPick[];
  execution: ExecutionRow[];
  log: LogLine[];
  /** Minor units. */
  totalMinor: number;
  /** Archived activities only: the line items to show in the archive view. */
  archiveLines?: { name: string; seller: string; price: string }[];
}

export interface Wallet {
  /** Minor units. */
  balanceMinor: number;
  address: string;
  network: string;
  cards: { pan: string; amount: string; status: "issued" | "viewed" | "used" | "expired" }[];
  transactions: {
    id: string;
    ts: string;
    label: string;
    ref: string;
    amount: string;
    debit: boolean;
  }[];
  /** Set after a top-up; the client shows it as a receipt strip. */
  receipt?: string;
}

export interface Mandate {
  autoApprove: boolean;
  /** Whole SGD, matching the slider units. */
  itemCap: number;
  actCap: number;
  categoryRules: Record<string, "allowed" | "ask first" | "blocked">;
}

export interface Settings {
  notify: boolean;
  sandbox: boolean;
  region: string;
  dataRetention: string;
}

export interface Profile {
  name: string;
  email: string;
  initials: string;
  memberSince: string;
  rows: { k: string; v: string }[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Server-sent events for one activity. The SSE `event:` field carries the type
 * and `data:` carries the JSON payload below.
 *
 * Ordering matters: emit `item.progress` at the moment the agent actually
 * moves, not batched on a clock. The client animates each event as it arrives,
 * so batching several into one frame collapses the motion the screen exists to
 * show.
 */
export type ActivityEvent =
  | { type: "activity.snapshot"; activity: Activity }
  | { type: "activity.stage"; stage: ActivityStage }
  | { type: "item.progress"; progress: ItemProgress }
  | { type: "agent.update"; agent: AgentState }
  | { type: "exec.step"; row: ExecutionRow }
  | { type: "log.line"; line: LogLine }
  | { type: "message.appended"; message: Message }
  | { type: "shortlist.ready"; shortlist: ShortlistPick[] }
  | { type: "activity.completed"; completedAt: string; totalMinor: number }
  | { type: "wallet.updated"; wallet: Wallet };

export type ConnectionState = "mock" | "connecting" | "open" | "error";

export interface Subscription {
  close: () => void;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Auth seam. No credentials are sent today; when the backend grows auth, this
 * is the only place that changes.
 *
 * Note EventSource cannot send custom headers, so any scheme added here must
 * also work for the SSE stream — a cookie, or a token in the query string.
 */
function authHeaders(): Record<string, string> {
  return {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export function listActivities(): Promise<Activity[]> {
  return isLive() ? get("/v1/activities") : mockBackend.listActivities();
}

export function getActivity(id: string): Promise<Activity> {
  return isLive() ? get(`/v1/activities/${id}`) : mockBackend.getActivity(id);
}

/** Starts a new activity from a free-text goal. Returns it already in `wishlist`. */
export function createActivity(goal: string): Promise<Activity> {
  return isLive() ? post("/v1/activities", { goal }) : mockBackend.createActivity(goal);
}

export function addWishlistItem(id: string, name: string): Promise<Activity> {
  return isLive()
    ? post(`/v1/activities/${id}/wishlist/items`, { name })
    : mockBackend.addWishlistItem(id, name);
}

export function removeWishlistItem(id: string, itemId: string): Promise<Activity> {
  return isLive()
    ? request(`/v1/activities/${id}/wishlist/items/${itemId}`, { method: "DELETE" })
    : mockBackend.removeWishlistItem(id, itemId);
}

export function approveWishlist(id: string): Promise<Activity> {
  return isLive() ? post(`/v1/activities/${id}/wishlist/approve`) : mockBackend.approveWishlist(id);
}

/** Locks one curator option for an item. */
export function chooseOption(id: string, itemId: string, option: string): Promise<Activity> {
  return isLive()
    ? post(`/v1/activities/${id}/clarifications/${itemId}`, { option })
    : mockBackend.chooseOption(id, itemId, option);
}

/** Dispatches the agents and begins the multi-agent search. */
export function dispatchAgents(id: string): Promise<Activity> {
  return isLive() ? post(`/v1/activities/${id}/dispatch`) : mockBackend.dispatchAgents(id);
}

export function setSearchPlaying(id: string, playing: boolean): Promise<Activity> {
  return isLive()
    ? post(`/v1/activities/${id}/search/${playing ? "resume" : "pause"}`)
    : mockBackend.setSearchPlaying(id, playing);
}

/** Rejects a shortlist pick and sends its agents back out for the alternate. */
export function rejectPick(id: string, itemId: string): Promise<Activity> {
  return isLive()
    ? post(`/v1/activities/${id}/shortlist/${itemId}/reject`)
    : mockBackend.rejectPick(id, itemId);
}

/**
 * Begins checkout. On the live rail this issues real single-use cards and
 * spends real money, so it is deliberately not retried anywhere in this client
 * and the UI confirms before calling it.
 *
 * `idempotencyKey` lets the backend collapse a duplicate submission (double
 * click, refresh mid-flight) into one execution rather than two.
 */
export function confirmPurchase(id: string, idempotencyKey: string): Promise<Activity> {
  return isLive()
    ? post(`/v1/activities/${id}/purchase`, { idempotencyKey })
    : mockBackend.confirmPurchase(id);
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

/**
 * Subscribes to one activity's event stream.
 *
 * The client treats the stream as the source of truth for anything that moves.
 * On reconnect the server should re-send `activity.snapshot` first so the UI
 * resynchronises rather than animating from a stale position.
 */
export function subscribeToActivity(
  id: string,
  onEvent: (event: ActivityEvent) => void,
  onState?: (state: ConnectionState) => void,
): Subscription {
  if (!isLive()) {
    onState?.("mock");
    return mockBackend.subscribe(id, onEvent);
  }

  onState?.("connecting");
  const source = new EventSource(`${API_BASE_URL}/v1/activities/${id}/events`);
  const types: ActivityEvent["type"][] = [
    "activity.snapshot",
    "activity.stage",
    "item.progress",
    "agent.update",
    "exec.step",
    "log.line",
    "message.appended",
    "shortlist.ready",
    "activity.completed",
    "wallet.updated",
  ];

  const handler = (type: ActivityEvent["type"]) => (e: MessageEvent<string>) => {
    try {
      onEvent({ type, ...JSON.parse(e.data) } as ActivityEvent);
    } catch {
      /* A malformed frame must not tear down a live purchase stream. */
    }
  };

  const handlers = types.map((type) => {
    const fn = handler(type);
    source.addEventListener(type, fn as EventListener);
    return [type, fn] as const;
  });

  source.onopen = () => onState?.("open");
  source.onerror = () =>
    onState?.(source.readyState === EventSource.CLOSED ? "error" : "connecting");

  return {
    close: () => {
      for (const [type, fn] of handlers) source.removeEventListener(type, fn as EventListener);
      source.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Wallet, mandate, settings, profile
// ---------------------------------------------------------------------------

export function getWallet(): Promise<Wallet> {
  return isLive() ? get("/v1/wallet") : mockBackend.getWallet();
}

export function topUpWallet(amountMinor: number): Promise<Wallet> {
  return isLive()
    ? post("/v1/wallet/topup", { amountMinor })
    : mockBackend.topUpWallet(amountMinor);
}

export function getMandate(): Promise<Mandate> {
  return isLive() ? get("/v1/mandate") : mockBackend.getMandate();
}

export function updateMandate(changes: Partial<Mandate>): Promise<Mandate> {
  return isLive() ? patch("/v1/mandate", changes) : mockBackend.updateMandate(changes);
}

export function getSettings(): Promise<Settings> {
  return isLive() ? get("/v1/settings") : mockBackend.getSettings();
}

export function updateSettings(changes: Partial<Settings>): Promise<Settings> {
  return isLive() ? patch("/v1/settings", changes) : mockBackend.updateSettings(changes);
}

export function getProfile(): Promise<Profile> {
  return isLive() ? get("/v1/profile") : mockBackend.getProfile();
}
