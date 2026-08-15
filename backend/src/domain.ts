export type ActivityStage = "idle" | "wishlist" | "curate" | "search" | "shortlist" | "exec";
export type ActivityStatus = "draft" | "live" | "completed" | "cancelled";
export type StageIndex = 0 | 1 | 2 | 3 | 4;

export interface WishlistItem {
  id: string;
  name: string;
  short: string;
  spec: string;
  budget: string;
  hueIndex: number;
  /** Used by mandate enforcement; the current frontend safely ignores it. */
  category?: string | undefined;
}

export interface CuratorOption {
  name: string;
  range: string;
  why: string;
  imgLabel: string;
  imageUrl?: string | undefined;
}

export interface Clarification {
  itemId: string;
  prompt: string;
  options: CuratorOption[];
  chosen?: string;
}

export interface Listing {
  title: string;
  seller: string;
  rating: string;
  price: string;
  amountMinor: number;
  why: string;
  imageUrl?: string | undefined;
  /** Canonical merchant listing URL used by the checkout service. */
  url?: string | undefined;
}

export interface ShortlistPick {
  itemId: string;
  listing: Listing;
  reSearched: boolean;
  /** Ranked fallbacks are kept for automatic retry but not rendered by the UI. */
  alternates?: Listing[] | undefined;
}

export interface ItemProgress {
  itemId: string;
  stage: StageIndex;
  previousStage: StageIndex;
  queued: boolean;
}

export interface AgentState {
  agentId: string;
  itemId: string;
  slot: number;
  url: string;
  stage: StageIndex;
  action: string;
  queued: boolean;
  /** Embeddable live browser stream supplied by the remote agent service. */
  liveStreamUrl?: string | undefined;
}

export interface ExecutionRow {
  itemId: string;
  step: number;
  state: "queued" | "live" | "purchased";
}

export interface LogLine {
  id: string;
  ts: string;
  tag: string;
  hueIndex: number;
  text: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  card?: "thinking" | "wishlist" | "curator" | "locked";
  thinkingLabel?: string;
  itemId?: string;
}

export interface Activity {
  id: string;
  userId: string;
  title: string;
  stage: ActivityStage;
  status: ActivityStatus;
  createdAt: string;
  completedAt?: string;
  displayTs: string;
  messages: Message[];
  wishlist: WishlistItem[];
  wishlistEstimate: string;
  clarifications: Clarification[];
  itemProgress: ItemProgress[];
  agents: AgentState[];
  searchPlaying: boolean;
  searchStartedAt?: string;
  shortlist: ShortlistPick[];
  execution: ExecutionRow[];
  log: LogLine[];
  totalMinor: number;
  archiveLines?: { name: string; seller: string; price: string }[];
}

export interface Wallet {
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
  receipt?: string;
}

export interface Mandate {
  autoApprove: boolean;
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

export const DEFAULT_USER_ID = "demo-user";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function formatMinor(minor: number): string {
  return `S$${(minor / 100).toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function displayTime(date = new Date()): string {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function logTime(date = new Date()): string {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
