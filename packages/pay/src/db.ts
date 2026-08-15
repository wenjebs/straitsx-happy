import Database from "better-sqlite3";

export type Db = {
  raw: Database.Database;
  tx<T>(fn: (t: Db) => T): T;
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY, per_item_cents INTEGER NOT NULL, daily_cents INTEGER NOT NULL,
  merchants TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES mandates(id),
  item_name TEXT NOT NULL, merchant_host TEXT NOT NULL, product_url TEXT,
  quoted_cents INTEGER NOT NULL, final_cents INTEGER, state TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0, order_ref TEXT, reserved_until TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS cards (
  purchase_id TEXT PRIMARY KEY REFERENCES purchases(id), issuer TEXT NOT NULL,
  opaque_id TEXT, last4 TEXT, expires_at TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS payments (
  nonce TEXT PRIMARY KEY, purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id),
  amount_cents INTEGER NOT NULL, valid_before TEXT NOT NULL, envelope TEXT NOT NULL,
  state TEXT NOT NULL, tx_hash TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id TEXT, kind TEXT NOT NULL,
  detail TEXT NOT NULL, at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_purchases_state ON purchases(state);
CREATE INDEX IF NOT EXISTS idx_payments_state ON payments(state);
`;

export function openDb(url: string): Db {
  const file = url.replace(/^file:/, "") || ":memory:";
  const raw = new Database(file);
  raw.exec(SCHEMA);
  const wrap = (r: Database.Database): Db => ({
    raw: r,
    tx<T>(fn: (t: Db) => T): T {
      return r.transaction(() => fn(wrap(r)))();
    },
  });
  return wrap(raw);
}
