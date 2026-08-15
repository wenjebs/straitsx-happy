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
  /** Public source page for the option image and its licence details. */
  imageSourceUrl?: string | undefined;
  imageAttribution?: string | undefined;
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
  action?: string | undefined;
  liveStreamUrl?: string | undefined;
}

/**
 * One item's attempt at being bought: its own card, its own grant, its own browser.
 *
 * Kept per attempt rather than per run so several items can be in flight at once. The whole point
 * of the split is that a callback names an `attemptId`, and everything it needs to act on — which
 * item, which candidate listing, which card — hangs off that id. Sharing one set of card fields
 * across concurrent attempts is how a card claimed for one item gets credited to another.
 */
export interface PurchaseAttempt {
  attemptId: string;
  itemId: string;
  /** Which of the item's candidate listings this attempt is for. */
  candidateIndex: number;
  /** Which retry of that candidate. */
  attemptIndex: number;
  cardGrantHash?: string | undefined;
  cardGrantExpiresAt?: string | undefined;
  cardClaimedAt?: string | undefined;
  cardId?: string | undefined;
  cardLast4?: string | undefined;
}

/** How far one shortlist item has got, independent of the others. */
export interface PurchaseItemProgress {
  candidateIndex: number;
  attemptIndex: number;
  done: boolean;
}

export interface PurchaseRun {
  activityId: string;
  userId: string;
  idempotencyKey: string;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Live attempts, keyed by attemptId. Several at once. */
  attempts: Record<string, PurchaseAttempt>;
  /** Per shortlist item, keyed by itemId. */
  progress: Record<string, PurchaseItemProgress>;
  processedEventIds: string[];
  updatedAt: string;
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

/** Immutable, full-document checkpoint written for every persisted activity transition. */
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

export interface WalletTransaction {
  id: string;
  ts: string;
  label: string;
  ref: string;
  amount: string;
  debit: boolean;
}

export interface Wallet {
  balanceMinor: number;
  address: string;
  network: string;
  cards: { pan: string; amount: string; status: "issued" | "viewed" | "used" | "expired" }[];
  transactions: WalletTransaction[];
  receipt?: string;
}

export type WalletDepositStatus = "pending" | "confirmed" | "failed";

/** Durable, idempotent record of an on-chain XSGD transfer into Happy's shared wallet. */
export interface WalletDeposit {
  id: string;
  userId: string;
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
  blockNumber?: string | undefined;
  failureReason?: string | undefined;
  explorerUrl?: string | undefined;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string | undefined;
}

export type FundingConfiguration =
  | {
      enabled: false;
      mode: "disabled";
      message: string;
    }
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
