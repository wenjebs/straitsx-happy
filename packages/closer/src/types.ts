import type { Page } from "playwright";

/** One chosen listing, produced by the discovery agent. */
export type Selection = {
  itemId: string;
  url: string;
  /** Item short tag for log lines, e.g. "SSD". Defaults to itemId.toUpperCase(). */
  tag?: string;
  /** 0-5, assigned by the activity in creation order. Defaults to the selection's index % 6. */
  hueIndex?: number;
  /** What the shortlist showed, in cents. Advisory only — the payment page is the authority. */
  expectedMinor?: number;
  itemName?: string;
};

export type PurchaseRequest = {
  activityId: string;
  idempotencyKey: string;
  selections: Selection[];
};

export type ItemStatus = "purchased" | "skipped" | "stranded" | "unknown";

export type ItemOutcome = {
  itemId: string;
  status: ItemStatus;
  reason?: string;
  purchaseId?: string;
  orderRef?: string | null;
  amountMinor?: number;
  last4?: string | null;
};

export type RunResult = {
  activityId: string;
  idempotencyKey: string;
  items: ItemOutcome[];
  /** Money that left the wallet: purchased + stranded. Spec §10.3. */
  totalMinor: number;
  startedAt: string;
  finishedAt: string;
  aborted: boolean;
};

export type ExecutionRow = {
  itemId: string;
  step: 0 | 1 | 2 | 3 | 4;
  state: "queued" | "live" | "purchased";
};

export type LogLine = { id: string; ts: string; tag: string; hueIndex: number; text: string };

export type CloserEvent =
  | { type: "exec.step"; row: ExecutionRow }
  | { type: "log.line"; line: LogLine }
  | { type: "run.completed"; completedAt: string; totalMinor: number }
  | { type: "wallet.dirty" };

// --- the subset of @happy/pay the Closer is allowed to touch ---------------------------------
// Declared structurally so tests can inject a fake that throws from issueCard while leaving the
// purchase in PAYING — the one path we most need covered and cannot provoke for real without
// spending money.

export type Quote = {
  amountCents: number;
  merchantHost: string;
  itemName: string;
  productUrl?: string;
};

export type Decision =
  | { decision: "ALLOW" }
  | { decision: "NEEDS_HUMAN"; reason: string }
  | { decision: "DENY"; reason: string };

export type MandateView = {
  perItemCents: number;
  dailyCents: number;
  remainingCents: number;
  limits: { minCardCents: number; maxCardCents: number };
};

export type CheckoutResult = { ok: boolean; orderRef?: string; error?: string };

/** @happy/pay's CheckoutOptions, as of 585a171. `confirm` is consulted only when the library's own
 *  [data-order-ref] check finds nothing and the page is not an explicit decline (fedc8bb). */
export type CheckoutOptions = {
  confirm?: (page: Page) => Promise<string | null>;
  submitSelector?: string;
};

export interface PayApi {
  getMandate(): Promise<MandateView | null>;
  evaluate(q: Quote): Promise<Decision>;
  reserve(q: Quote): Promise<{ id: string }>;
  issueCard(
    purchaseId: string,
    finalTotalCents: number,
  ): Promise<{ last4: string | null; expiresAt: string | null; settlementTx: string | null }>;
  payWithCard(page: Page, purchaseId: string, opts?: CheckoutOptions): Promise<CheckoutResult>;
  complete(purchaseId: string, orderRef: string | null): Promise<void>;
  cancel(purchaseId: string, reason: string): Promise<void>;
  getPurchase(purchaseId: string): Promise<{ state: string } | null>;
}

// --- merchants ---------------------------------------------------------------------------------

export type ShippingProfile = {
  name: string;
  email: string;
  addressLine: string;
  postalCode: string;
  phone: string;
};

export type AdapterContext = {
  shipping: ShippingProfile;
  log: (text: string) => void;
  /** Absolute deadline (epoch ms) for pre-issuance work on this item. */
  deadlineAt: number;
};

export interface MerchantAdapter {
  readonly name: string;
  matches(url: URL): boolean;
  /** Product page → loaded payment page with the card form visible. May fill shipping and contact
   *  fields. MUST NOT submit. Throwing abandons the item, which is free before issuance. */
  toPaymentPage(page: Page, ctx: AdapterContext): Promise<void>;
  /** The all-in total in cents, read from structured markup — never from merchant prose. */
  readFinalTotalCents(page: Page): Promise<number>;
  /** Handed to payWithCard as opts.confirm. Must return a real order reference or null; "probably
   *  fine" is not an option. Since fedc8bb the library settles an explicit decline first and never
   *  consults confirm() on a declined page, but an adapter still owes positive evidence — spec §5. */
  confirmOrder?(page: Page): Promise<string | null>;
  /** Handed to payWithCard as opts.submitSelector when the library's form-scoped discovery is wrong. */
  submitSelector?: string;
}

export type BrowserLike = { newPage(): Promise<Page> };
