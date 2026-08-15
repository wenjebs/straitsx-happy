import type { Db } from "./db.js";

export type AuditEvent = {
  id: number;
  purchaseId: string | null;
  kind: string;
  detail: unknown;
  at: string;
};

const FORBIDDEN = /pan|cvv|cvc|number|signature|privatekey/;

// Normalise the key (strip underscores, lowercase) before testing so casing and
// separator choices can't smuggle secrets past the filter — `spendPrivateKey`,
// `card_number` and `cardNumber` must all redact the same way.
const isForbiddenKey = (key: string): boolean =>
  FORBIDDEN.test(key.replace(/_/g, "").toLowerCase());

export function appendAudit(
  db: Db,
  e: { purchaseId?: string; kind: string; detail: unknown },
): void {
  const detail = JSON.stringify(e.detail ?? {}, (k, v) => (isForbiddenKey(k) ? "[redacted]" : v));
  db.raw
    .prepare(`INSERT INTO audit_events (purchase_id, kind, detail, at) VALUES (?,?,?,?)`)
    .run(e.purchaseId ?? null, e.kind, detail, new Date().toISOString());
}

export function readAudit(db: Db, purchaseId: string): AuditEvent[] {
  return db.raw
    .prepare(`SELECT * FROM audit_events WHERE purchase_id = ? ORDER BY id`)
    .all(purchaseId)
    .map((r: any) => ({
      id: r.id,
      purchaseId: r.purchase_id,
      kind: r.kind,
      detail: JSON.parse(r.detail),
      at: r.at,
    }));
}
