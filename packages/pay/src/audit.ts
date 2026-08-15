import type { Db } from "./db.js";

export type AuditEvent = {
  id: number;
  purchaseId: string | null;
  kind: string;
  detail: unknown;
  at: string;
};

const FORBIDDEN = /(^|_)(pan|cvv|cvc|number|signature|privateKey)($|_)/i;

export function appendAudit(
  db: Db,
  e: { purchaseId?: string; kind: string; detail: unknown },
): void {
  const detail = JSON.stringify(e.detail ?? {}, (k, v) => (FORBIDDEN.test(k) ? "[redacted]" : v));
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
