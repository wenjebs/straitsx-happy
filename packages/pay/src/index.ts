import type { Page } from "playwright";
import { readAudit } from "./audit.js";
import { payWithCard as fill } from "./checkout.js";
import { type Cents, type Config, loadConfig } from "./config.js";
import { type Db, openDb } from "./db.js";
import { MockIssuer } from "./issuer/mock.js";
import { StraitsXIssuer } from "./issuer/straitsx.js";
import type { IssuerAdapter } from "./issuer/types.js";
import * as L from "./ledger.js";
import { issueCardFor } from "./purchase.js";
import { startRecon } from "./recon.js";
import { makeWallet, type Wallet } from "./wallet.js";
import { TokenBucket } from "./x402/bucket.js";

export type { Cents } from "./config.js";
export { MandateError } from "./ledger.js";
export type { Decision, Reason } from "./rules.js";

type Ctx = { cfg: Config; db: Db; wallet: Wallet; issuer: IssuerAdapter; stopRecon: () => void };
let ctx: Ctx | null = null;

function get(): Ctx {
  if (ctx) return ctx;
  const cfg = loadConfig();
  const db = openDb(cfg.databaseUrl);
  const wallet = makeWallet(cfg);
  let issuer: IssuerAdapter;
  if (cfg.issuer === "mock") {
    issuer = new MockIssuer();
  } else {
    if (!wallet.account) throw new Error("ISSUER=straitsx requires SPEND_PRIVATE_KEY");
    issuer = new StraitsXIssuer(
      cfg,
      wallet.account,
      new TokenBucket(cfg.railBucketCapacity, cfg.railBucketRefillMs),
      fetch,
      noteRailStatus,
    );
  }
  wallet.start();
  const stopRecon = startRecon({ db, cfg, wallet, issuer });
  ctx = { cfg, db, wallet, issuer, stopRecon };
  return ctx;
}

/** Test and shutdown helper. */
export function shutdown() {
  if (!ctx) return;
  ctx.wallet.stop();
  ctx.stopRecon();
  ctx = null;
}

export type Quote = {
  amountCents: Cents;
  merchantHost: string;
  itemName: string;
  productUrl?: string;
};

/** Whole dollars render as S$25, cents as S$18.50 — the footer in the spec shows no trailing .00. */
const display = (c: Cents) => `S$${c % 100 === 0 ? c / 100 : (c / 100).toFixed(2)}`;

function shape(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    state: row.state,
    itemName: row.item_name,
    merchantHost: row.merchant_host,
    quotedCents: row.quoted_cents,
    finalCents: row.final_cents,
    orderRef: row.order_ref,
    last4: row.last4 ?? null,
    settlementTx: row.tx_hash ?? null,
    createdAt: row.created_at,
  };
}

export async function createMandate(opts: {
  perItemCents: Cents;
  dailyCents: Cents;
  merchants: string[];
  expiresAt: Date;
}) {
  const { db, cfg } = get();
  await L.createMandate(db, cfg, opts);
  return (await getMandate())!;
}

export async function getMandate() {
  const { db, cfg } = get();
  const m = L.getMandateRow(db);
  if (!m) return null;
  const t = L.totals(db, m.id);
  return {
    id: m.id,
    perItemCents: m.per_item_cents,
    dailyCents: m.daily_cents,
    merchants: JSON.parse(m.merchants) as string[],
    expiresAt: m.expires_at,
    status: m.status,
    spentCents: t.spentCents,
    reservedCents: t.reservedCents,
    remainingCents: Math.max(0, m.daily_cents - t.spentCents - t.reservedCents),
    strandedCents: t.strandedCents,
    limits: { minCardCents: cfg.minCardCents, maxCardCents: cfg.maxCardCents },
    footer:
      `Mandate active · auto-approve under ${display(m.per_item_cents)}/item · ` +
      `${display(m.daily_cents)}/day · card issued per purchase`,
  };
}

export async function revokeMandate(reason: string) {
  L.revokeMandate(get().db, reason);
}

export async function evaluate(q: Quote) {
  const { db, cfg, wallet } = get();
  await wallet.ready();
  return L.evaluateQuote(db, cfg, wallet.view(), q);
}

export async function reserve(q: Quote) {
  const { db, cfg, wallet } = get();
  await wallet.ready();
  return shape(await L.reserveQuote(db, cfg, wallet.view(), q))!;
}

export async function approve(purchaseId: string) {
  L.approvePurchase(get().db, purchaseId);
}

export async function issueCard(purchaseId: string, finalTotalCents: Cents) {
  const { db, cfg, issuer, wallet } = get();
  await wallet.ready();
  const r = await issueCardFor({ db, cfg, issuer, wallet }, purchaseId, finalTotalCents);
  return { last4: r.last4, expiresAt: r.expiresAt, settlementTx: r.settlementTx };
}

export async function payWithCard(page: Page, purchaseId: string) {
  const { db, issuer } = get();
  return fill({ db, issuer }, page, purchaseId);
}

export async function complete(purchaseId: string, orderRef: string | null) {
  L.markDone(get().db, purchaseId, orderRef);
}
export async function cancel(purchaseId: string, reason: string) {
  L.markCancelled(get().db, purchaseId, reason);
}

export async function getPurchase(id: string) {
  const { db } = get();
  return shape(
    db.raw
      .prepare(
        `SELECT p.*, c.last4, pay.tx_hash FROM purchases p
     LEFT JOIN cards c ON c.purchase_id = p.id
     LEFT JOIN payments pay ON pay.purchase_id = p.id WHERE p.id = ?`,
      )
      .get(id),
  );
}

export async function listPurchases(limit = 20) {
  const { db } = get();
  return db.raw
    .prepare(
      `SELECT p.*, c.last4, pay.tx_hash FROM purchases p
     LEFT JOIN cards c ON c.purchase_id = p.id
     LEFT JOIN payments pay ON pay.purchase_id = p.id
     ORDER BY p.created_at DESC LIMIT ?`,
    )
    .all(limit)
    .map(shape);
}

export async function getAuditLog(purchaseId: string) {
  return readAudit(get().db, purchaseId);
}

export async function getWallet() {
  const { cfg, db, wallet } = get();
  await wallet.ready();
  const v = wallet.view();
  const m = L.getMandateRow(db);
  const t = L.totals(db, m?.id ?? null);
  // With no signing key the wallet reports MAX_SAFE_INTEGER so the rules engine never blocks
  // on liquidity. That is not a balance a UI should render — report null instead.
  const mock = cfg.issuer === "mock" || !cfg.spendPrivateKey;
  return {
    address: mock ? null : wallet.address,
    balanceCents: mock ? null : v.balanceCents,
    availableCents: mock ? null : v.balanceCents - t.reservedCents,
    healthy: mock ? true : v.ageMs < 60_000,
    staleMs: mock ? 0 : v.ageMs,
  };
}

let railLast: { status: "OK" | "RATE_LIMITED" | "ERROR" | "UNKNOWN"; at: number | null } = {
  status: "UNKNOWN",
  at: null,
};
export function noteRailStatus(status: "OK" | "RATE_LIMITED" | "ERROR") {
  railLast = { status, at: Date.now() };
}

/** Never touches the rail — reports what real work last observed. */
export async function health() {
  const { cfg, wallet } = get();
  await wallet.ready();
  const v = wallet.view();
  const blockers: string[] = [];
  if (cfg.issuer === "straitsx" && v.balanceCents <= 0) blockers.push("wallet has no XSGD");
  if (cfg.issuer === "straitsx" && !cfg.spendPrivateKey) blockers.push("SPEND_PRIVATE_KEY not set");
  return {
    issuer: cfg.issuer,
    railLastStatus: railLast.status,
    railLastSeenMs: railLast.at ? Date.now() - railLast.at : null,
    chainReachable: v.ageMs < 60_000,
    readyToIssue: blockers.length === 0,
    blockers,
  };
}
