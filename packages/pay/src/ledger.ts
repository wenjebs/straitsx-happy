import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { appendAudit } from './audit.js';
import { decide, type Decision, type Reason } from './rules.js';
import type { Cents, Config } from './config.js';

export class MandateError extends Error {
  constructor(public readonly reason: Reason, public readonly purchaseId?: string) {
    super(`mandate: ${reason}`);
    this.name = 'MandateError';
  }
}

export type ChainView = { balanceCents: Cents; ageMs: number };
export type QuoteInput = { amountCents: Cents; merchantHost: string; itemName: string; productUrl?: string };

const iso = (d = new Date()) => d.toISOString();

export function getMandateRow(db: Db) {
  return db.raw.prepare(`SELECT * FROM mandates WHERE status='ACTIVE' ORDER BY created_at DESC LIMIT 1`).get() as any;
}

export function totals(db: Db) {
  const r = db.raw.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN state IN ('CARD_ISSUED','DONE','STRANDED') THEN final_cents END),0) AS spent,
      COALESCE(SUM(CASE WHEN state IN ('RESERVED','PAYING') THEN quoted_cents END),0)            AS reserved,
      COALESCE(SUM(CASE WHEN state='STRANDED' THEN final_cents END),0)                           AS stranded
    FROM purchases`).get() as any;
  return { spentCents: r.spent as Cents, reservedCents: r.reserved as Cents, strandedCents: r.stranded as Cents };
}

export async function createMandate(db: Db, _cfg: Config, opts: {
  perItemCents: Cents; dailyCents: Cents; merchants: string[]; expiresAt: Date;
}) {
  const id = `mnd_${randomUUID()}`;
  db.tx((t) => {
    t.raw.prepare(`UPDATE mandates SET status='REVOKED' WHERE status='ACTIVE'`).run();
    t.raw.prepare(`INSERT INTO mandates VALUES (?,?,?,?,?,?,?)`)
      .run(id, opts.perItemCents, opts.dailyCents, JSON.stringify(opts.merchants.map((m) => m.toLowerCase())),
           opts.expiresAt.toISOString(), 'ACTIVE', iso());
    appendAudit(t, { kind: 'MANDATE_CREATED', detail: { id, perItemCents: opts.perItemCents } });
  });
  return getMandateRow(db);
}

export function revokeMandate(db: Db, reason: string) {
  db.tx((t) => {
    t.raw.prepare(`UPDATE mandates SET status='REVOKED' WHERE status='ACTIVE'`).run();
    appendAudit(t, { kind: 'MANDATE_REVOKED', detail: { reason } });
  });
}

function context(db: Db, cfg: Config, chain: ChainView, ownReservationCents: Cents) {
  const m = getMandateRow(db);
  const t = totals(db);
  return {
    config: cfg,
    now: Date.now(),
    mandate: m ? {
      id: m.id, status: m.status, expiresAtMs: Date.parse(m.expires_at),
      perItemCents: m.per_item_cents, dailyCents: m.daily_cents,
      merchants: JSON.parse(m.merchants) as string[],
    } : null,
    spentCents: t.spentCents,
    reservedCents: t.reservedCents,
    ownReservationCents,
    balanceCents: chain.balanceCents,
    balanceAgeMs: chain.ageMs,
  };
}

export function evaluateQuote(db: Db, cfg: Config, chain: ChainView, q: QuoteInput): Decision {
  return decide({ amountCents: q.amountCents, merchantHost: q.merchantHost.toLowerCase() },
                context(db, cfg, chain, 0));
}

export async function reserveQuote(db: Db, cfg: Config, chain: ChainView, q: QuoteInput) {
  return db.tx((t) => {
    const d = decide({ amountCents: q.amountCents, merchantHost: q.merchantHost.toLowerCase() },
                     context(t, cfg, chain, 0));
    if (d.decision === 'DENY') throw new MandateError(d.reason);

    const id = `pur_${randomUUID()}`;
    const m = getMandateRow(t);
    t.raw.prepare(`INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, m.id, q.itemName, q.merchantHost.toLowerCase(), q.productUrl ?? null,
      q.amountCents, null, 'RESERVED', d.decision === 'NEEDS_HUMAN' ? 0 : 1, null,
      new Date(Date.now() + cfg.reservationTtlMs).toISOString(), iso(), iso());
    appendAudit(t, { purchaseId: id, kind: 'RESERVED', detail: { amountCents: q.amountCents, band: d.decision } });
    return t.raw.prepare(`SELECT * FROM purchases WHERE id=?`).get(id) as any;
  });
}

export function approvePurchase(db: Db, purchaseId: string) {
  db.tx((t) => {
    t.raw.prepare(`UPDATE purchases SET approved=1, updated_at=? WHERE id=?`).run(iso(), purchaseId);
    appendAudit(t, { purchaseId, kind: 'APPROVED', detail: {} });
  });
}

function requireState(db: Db, id: string, expected: string[]) {
  const row = db.raw.prepare(`SELECT * FROM purchases WHERE id=?`).get(id) as any;
  if (!row) throw new Error(`unknown purchase ${id}`);
  if (!expected.includes(row.state)) throw new Error(`purchase ${id} is ${row.state}, expected ${expected.join('|')}`);
  return row;
}

export function markPaying(db: Db, id: string, finalCents: Cents) {
  db.tx((t) => {
    requireState(t, id, ['RESERVED']);
    t.raw.prepare(`UPDATE purchases SET state='PAYING', final_cents=?, updated_at=? WHERE id=?`)
      .run(finalCents, iso(), id);
    appendAudit(t, { purchaseId: id, kind: 'PAYING', detail: { finalCents } });
  });
}

export function markIssued(db: Db, id: string, finalCents: Cents, card: {
  issuer: string; opaqueId: string | null; last4: string | null; expiresAt: string | null;
}) {
  db.tx((t) => {
    requireState(t, id, ['PAYING']);
    t.raw.prepare(`UPDATE purchases SET state='CARD_ISSUED', final_cents=?, updated_at=? WHERE id=?`)
      .run(finalCents, iso(), id);
    t.raw.prepare(`INSERT OR REPLACE INTO cards VALUES (?,?,?,?,?,?,?)`)
      .run(id, card.issuer, card.opaqueId, card.last4, card.expiresAt, 'ACTIVE', iso());
    appendAudit(t, { purchaseId: id, kind: 'CARD_ISSUED', detail: { finalCents, last4: card.last4 } });
  });
}

export function markFailed(db: Db, id: string, detail: unknown) {
  db.tx((t) => {
    requireState(t, id, ['PAYING']);
    t.raw.prepare(`UPDATE purchases SET state='FAILED', updated_at=? WHERE id=?`).run(iso(), id);
    appendAudit(t, { purchaseId: id, kind: 'FAILED', detail });
  });
}

export function markDone(db: Db, id: string, orderRef: string | null) {
  db.tx((t) => {
    requireState(t, id, ['CARD_ISSUED']);
    t.raw.prepare(`UPDATE purchases SET state='DONE', order_ref=?, updated_at=? WHERE id=?`).run(orderRef, iso(), id);
    t.raw.prepare(`UPDATE cards SET state='SPENT' WHERE purchase_id=?`).run(id);
    appendAudit(t, { purchaseId: id, kind: 'DONE', detail: { orderRef } });
  });
}

export function markCancelled(db: Db, id: string, reason: string) {
  db.tx((t) => {
    const row = t.raw.prepare(`SELECT state FROM purchases WHERE id=?`).get(id) as any;
    if (!row) throw new Error(`unknown purchase ${id}`);
    if (row.state === 'PAYING') throw new Error(`cannot cancel ${id}: PAYING — settlement outcome unknown`);
    const next = row.state === 'CARD_ISSUED' ? 'STRANDED' : 'RELEASED';
    t.raw.prepare(`UPDATE purchases SET state=?, updated_at=? WHERE id=?`).run(next, iso(), id);
    if (next === 'STRANDED') t.raw.prepare(`UPDATE cards SET state='DEAD' WHERE purchase_id=?`).run(id);
    appendAudit(t, { purchaseId: id, kind: next, detail: { reason } });
  });
}

/** Releases reservations past their TTL. Never touches PAYING. Returns how many were released. */
export function releaseExpired(db: Db): number {
  return db.tx((t) => {
    const rows = t.raw.prepare(`SELECT id FROM purchases WHERE state='RESERVED' AND reserved_until < ?`)
      .all(iso()) as any[];
    for (const r of rows) {
      t.raw.prepare(`UPDATE purchases SET state='RELEASED', updated_at=? WHERE id=?`).run(iso(), r.id);
      appendAudit(t, { purchaseId: r.id, kind: 'RELEASED', detail: { reason: 'reservation_expired' } });
    }
    return rows.length;
  });
}
