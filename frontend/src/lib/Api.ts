import { debug } from "./debug";
/*
 * Every call the UI makes to the backend.
 *
 * There is one mode: live HTTP + SSE against VITE_API_BASE_URL. There used to be
 * a second — an in-browser mock that advanced the whole flow on timers — and it
 * is gone. The search phase now runs real browsers over real storefronts, so a
 * simulation of it could only ever disagree with the thing it simulated, and a
 * screen full of invented listings is worse than a screen that says the backend
 * is not running.
 *
 * The wire contract these functions assume is written out in full in
 * ../BACKEND_CONTRACT.md. Change one, change the other.
 */

export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

/** True when a backend origin is configured. Nothing works without one. */
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
  /** Click-through to the original image and licence details. */
  imageSourceUrl?: string;
  imageAttribution?: string;
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
  /** Current Closer status text supplied by the backend callback. */
  action?: string;
  /** Embeddable live browser stream supplied by the Closer agent. */
  liveStreamUrl?: string;
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

export interface ActivityCheckpoint {
  checkpointId: string;
  activityId: string;
  userId: string;
  reason: string;
  createdAt: string;
  stage: ActivityStage;
  status: ActivityStatus;
  activity: Activity;
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

export type WalletDepositStatus = "pending" | "confirmed" | "failed";

export interface WalletDeposit {
  id: string;
  txHash: string;
  sourceAddress: string;
  destinationAddress: string;
  tokenAddress: string;
  chainId: number;
  status: WalletDepositStatus;
  amountAtomic: string | null;
  amountMinor: number | null;
  confirmations: number;
  requiredConfirmations: number;
  blockNumber?: string;
  failureReason?: string;
  explorerUrl?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}

export type FundingConfiguration =
  | { enabled: false; mode: "disabled"; message: string }
  | {
      enabled: true;
      mode: "chain";
      walletAddress: string;
      tokenAddress: string;
      tokenSymbol: "XSGD";
      tokenDecimals: number;
      chainId: number;
      networkName: string;
      rpcUrl: string;
      explorerUrl: string;
      requiredConfirmations: number;
    };

export interface WalletFundingSnapshot {
  configuration: FundingConfiguration;
  deposits: WalletDeposit[];
}

export interface WalletDepositResult {
  deposit: WalletDeposit;
  wallet: Wallet;
}

export interface Mandate {
  autoApprove: boolean;
  /** Whole SGD entered by the user. */
  itemCap: number;
  actCap: number;
}

export interface ShippingAddress {
  recipientName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  country: string;
  phone: string;
}

export interface Settings {
  region: string;
  dataRetention: string;
  shippingAddress: ShippingAddress | null;
}

export interface Profile {
  name: string;
  email: string;
  initials: string;
  memberSince: string;
  rows: { k: string; v: string }[];
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  initials: string;
  createdAt: string;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
}

export interface SignupResult {
  confirmationRequired: boolean;
  email: string;
  session?: AuthSession;
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

export type ConnectionState = "connecting" | "open" | "error";

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

const AUTH_SESSION_TOKEN = "happy.auth.session";
const AUTH_REFRESH_TOKEN = "happy.auth.refresh";
const AUTH_CHANGED_EVENT = "happy:auth-changed";
const WALLET_SESSION_TOKEN = "happy.wallet.session";
const WALLET_SESSION_ADDRESS = "happy.wallet.address";

function authHeaders(): Record<string, string> {
  const authToken = authSessionToken();
  const walletToken = walletSessionToken();
  return {
    ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    ...(walletToken ? { "x-happy-wallet-session": walletToken } : {}),
  };
}

async function request<T>(path: string, init?: RequestInit, retryAuth = true): Promise<T> {
  if (!isLive()) {
    throw new ApiError(
      0,
      "VITE_API_BASE_URL is not set, so there is no backend to talk to. Start the backend and point the frontend at it.",
    );
  }
  const startedAt = performance.now();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...init?.headers,
    },
  });
  debug.request(init?.method ?? "GET", path, res.status, performance.now() - startedAt);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      if (/wallet|deposit/i.test(body)) clearWalletSession();
      else if (retryAuth && !path.startsWith("/v1/auth/") && (await tryRefreshAuth())) {
        return request<T>(path, init, false);
      } else clearAuthSession();
    }
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

function authSessionToken(): string | null {
  return typeof window === "undefined" ? null : window.localStorage.getItem(AUTH_SESSION_TOKEN);
}

async function tryRefreshAuth(): Promise<boolean> {
  if (typeof window === "undefined" || !isLive()) return false;
  const refreshToken = window.localStorage.getItem(AUTH_REFRESH_TOKEN);
  if (!refreshToken) return false;
  try {
    const response = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return false;
    storeAuthSession((await response.json()) as AuthSession);
    return true;
  } catch {
    return false;
  }
}

export function hasAuthSession(): boolean {
  return authSessionToken() !== null;
}

export function storeAuthSession(session: AuthSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTH_SESSION_TOKEN, session.accessToken);
  if (session.refreshToken) {
    window.localStorage.setItem(AUTH_REFRESH_TOKEN, session.refreshToken);
  }
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

export function clearAuthSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_SESSION_TOKEN);
  window.localStorage.removeItem(AUTH_REFRESH_TOKEN);
  clearWalletSession();
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

export function onAuthChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(AUTH_CHANGED_EVENT, listener);
  return () => window.removeEventListener(AUTH_CHANGED_EVENT, listener);
}

export async function signup(name: string, email: string, password: string): Promise<SignupResult> {
  if (!isLive()) throw new Error("Start the backend to create an account.");
  const result = await post<SignupResult>("/v1/auth/signup", { name, email, password });
  if (result.session) storeAuthSession(result.session);
  return result;
}

export async function confirmSignup(email: string, code: string): Promise<void> {
  if (!isLive()) return;
  await post("/v1/auth/confirm", { email, code });
}

export async function login(email: string, password: string): Promise<AuthSession> {
  if (!isLive()) throw new Error("Start the backend to sign in.");
  const session = await post<AuthSession>("/v1/auth/login", { email, password });
  storeAuthSession(session);
  return session;
}

export function getCurrentUser(): Promise<AuthUser> {
  if (!isLive()) {
    return Promise.resolve({
      id: "mock-user",
      email: "demo@happy.local",
      name: "Happy Demo",
      initials: "HD",
      createdAt: new Date().toISOString(),
    });
  }
  return get("/v1/auth/me");
}

export async function logout(): Promise<void> {
  try {
    if (isLive() && hasAuthSession()) await post("/v1/auth/logout");
  } finally {
    clearAuthSession();
  }
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export function listActivities(): Promise<Activity[]> {
  return get("/v1/activities");
}

export function getActivity(id: string): Promise<Activity> {
  return get(`/v1/activities/${id}`);
}

export function getActivityHistory(id: string): Promise<ActivityCheckpoint[]> {
  return get(`/v1/activities/${id}/checkpoints`);
}

/** Starts a new activity from a free-text goal. Returns it already in `wishlist`. */
export function createActivity(goal: string): Promise<Activity> {
  return post("/v1/activities", { goal });
}

export function addWishlistItem(id: string, name: string): Promise<Activity> {
  return post(`/v1/activities/${id}/wishlist/items`, { name });
}

export function removeWishlistItem(id: string, itemId: string): Promise<Activity> {
  return request(`/v1/activities/${id}/wishlist/items/${itemId}`, { method: "DELETE" });
}

export function approveWishlist(id: string): Promise<Activity> {
  return post(`/v1/activities/${id}/wishlist/approve`);
}

/** Returns curation to the editable wishlist and discards all option choices. */
export function reopenWishlist(id: string): Promise<Activity> {
  return post(`/v1/activities/${id}/wishlist/reopen`);
}

/** Locks one curator option for an item. */
export function chooseOption(id: string, itemId: string, option: string): Promise<Activity> {
  return post(`/v1/activities/${id}/clarifications/${itemId}`, { option });
}

/** Dispatches the scouts and begins the multi-agent search on real browsers. */
export function dispatchAgents(id: string): Promise<Activity> {
  return post(`/v1/activities/${id}/dispatch`);
}

export function setSearchPlaying(id: string, playing: boolean): Promise<Activity> {
  return post(`/v1/activities/${id}/search/${playing ? "resume" : "pause"}`);
}

/** Rejects a shortlist pick and promotes the alternate the scouts already priced. */
export function rejectPick(id: string, itemId: string): Promise<Activity> {
  return post(`/v1/activities/${id}/shortlist/${itemId}/reject`);
}

/**
 * Begins checkout. The backend owns provider selection and all retries, so it
 * is deliberately not retried anywhere in this client.
 *
 * `idempotencyKey` lets the backend collapse a duplicate submission (double
 * click, refresh mid-flight) into one execution rather than two.
 */
export function confirmPurchase(id: string, idempotencyKey: string): Promise<Activity> {
  return post(`/v1/activities/${id}/purchase`, { idempotencyKey });
}

/** Stops all future work for a live activity and rejects late agent callbacks. */
export function cancelActivity(id: string): Promise<Activity> {
  return post(`/v1/activities/${id}/cancel`);
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
    onState?.("error");
    return { close: () => {} };
  }

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

  let closed = false;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = async () => {
    if (closed) return;
    onState?.("connecting");
    controller = new AbortController();
    try {
      const response = await fetch(`${API_BASE_URL}/v1/activities/${id}/events`, {
        headers: authHeaders(),
        signal: controller.signal,
      });
      if (response.status === 401) {
        if (await tryRefreshAuth()) {
          await connect();
          return;
        }
        clearAuthSession();
        throw new ApiError(401, "Login session expired.");
      }
      if (!response.ok || !response.body) {
        throw new ApiError(response.status, `Activity stream failed (${response.status}).`);
      }
      onState?.("open");
      debug.stream(id, "open");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          dispatchSseFrame(frame, types, onEvent);
          boundary = buffer.indexOf("\n\n");
        }
      }
      if (!closed) throw new Error("Activity stream closed.");
    } catch (error) {
      if (closed || (error instanceof DOMException && error.name === "AbortError")) return;
      debug.error(`stream ${id}`, error);
      onState?.("connecting");
      debug.stream(id, "reconnecting in 1500ms");
      reconnectTimer = setTimeout(() => void connect(), 1500);
    }
  };

  void connect();
  return {
    close: () => {
      closed = true;
      controller?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    },
  };
}

function dispatchSseFrame(
  frame: string,
  types: ActivityEvent["type"][],
  onEvent: (event: ActivityEvent) => void,
): void {
  let type = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice("event:".length).trim();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (!types.includes(type as ActivityEvent["type"]) || data.length === 0) return;
  try {
    const parsed = JSON.parse(data.join("\n"));
    debug.event(String(parsed.activityId ?? parsed.id ?? ""), type, parsed);
    onEvent({ type, ...parsed } as ActivityEvent);
  } catch {
    /* A malformed frame must not tear down a live purchase stream. */
  }
}

// ---------------------------------------------------------------------------
// Wallet, mandate, settings, profile
// ---------------------------------------------------------------------------

export function getWallet(): Promise<Wallet> {
  return get("/v1/wallet");
}

export interface WalletAuthChallenge {
  challengeToken: string;
  message: string;
  expiresAt: string;
}

export interface WalletAuthSession {
  sessionToken: string;
  address: string;
  expiresAt: string;
}

export function createWalletAuthChallenge(address: string): Promise<WalletAuthChallenge> {
  if (!isLive()) throw new Error("Start the backend to authorize a funding wallet.");
  return post("/v1/wallet/auth/challenge", { address });
}

export async function verifyWalletAuth(
  challengeToken: string,
  signature: string,
): Promise<WalletAuthSession> {
  if (!isLive()) throw new Error("Start the backend to authorize a funding wallet.");
  const session = await post<WalletAuthSession>("/v1/wallet/auth/verify", {
    challengeToken,
    signature,
  });
  window.localStorage.setItem(WALLET_SESSION_TOKEN, session.sessionToken);
  window.localStorage.setItem(WALLET_SESSION_ADDRESS, session.address.toLowerCase());
  return session;
}

export function getWalletSessionAddress(): string | null {
  return typeof window === "undefined" ? null : window.localStorage.getItem(WALLET_SESSION_ADDRESS);
}

function walletSessionToken(): string | null {
  return typeof window === "undefined" ? null : window.localStorage.getItem(WALLET_SESSION_TOKEN);
}

export function clearWalletSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(WALLET_SESSION_TOKEN);
  window.localStorage.removeItem(WALLET_SESSION_ADDRESS);
}

export function getWalletFunding(): Promise<WalletFundingSnapshot> {
  return isLive()
    ? get("/v1/wallet/funding")
    : Promise.resolve({
        configuration: {
          enabled: false,
          mode: "disabled",
          message: "Start the backend to make a real XSGD deposit.",
        },
        deposits: [],
      });
}

export function registerWalletDeposit(
  txHash: string,
  sourceAddress: string,
): Promise<WalletDepositResult> {
  if (!isLive()) throw new Error("Start the backend to register a real XSGD deposit.");
  return post("/v1/wallet/deposits", { txHash, sourceAddress });
}

export function refreshWalletDeposit(txHash: string): Promise<WalletDepositResult> {
  if (!isLive()) throw new Error("Start the backend to verify a real XSGD deposit.");
  return get(`/v1/wallet/deposits/${encodeURIComponent(txHash)}`);
}

export function getMandate(): Promise<Mandate> {
  return get("/v1/mandate");
}

export function updateMandate(changes: Partial<Mandate>): Promise<Mandate> {
  return patch("/v1/mandate", changes);
}

export function getSettings(): Promise<Settings> {
  return get("/v1/settings");
}

export function updateSettings(changes: Partial<Settings>): Promise<Settings> {
  return patch("/v1/settings", changes);
}

export function getProfile(): Promise<Profile> {
  return get("/v1/profile");
}


// ---------------------------------------------------------------------------
// Health — which rail the backend is on
// ---------------------------------------------------------------------------

export interface HealthNetwork {
  chainId: number;
  name: string;
  issuer: "mock" | "straitsx";
  cardApi: "sandbox" | "production";
  walletAddress: string | null;
  explorerUrl: string;
  /** True only when the chain, the issuer and the card API all say production. */
  realMoney: boolean;
}

export interface Health {
  ok: boolean;
  scoutProvider: string;
  cardProvider: string;
  purchaseAgentProvider: string;
  network: HealthNetwork;
  blockers: string[];
  warnings: string[];
}

export async function getHealth(): Promise<Health> {
  const health = await get<Health>("/v1/health");
  debug.rail(health as unknown as Record<string, unknown>);
  return health;
}
