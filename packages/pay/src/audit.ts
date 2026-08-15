import type { Db } from "./db.js";

export type AuditEvent = {
  id: number;
  purchaseId: string | null;
  kind: string;
  detail: unknown;
  at: string;
};

// Splits an identifier into lowercase word tokens on non-alphanumeric separators
// and camelCase boundaries. An acronym run like "PAN" or "CVV" tokenises as one
// token, not one token per letter — the lookahead in the first alternative only
// fires when a cap run is *followed by* a capitalised word (e.g. "XMLParser").
const tokenize = (key: string): string[] =>
  key
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g)
    ?.map((t) => t.toLowerCase()) ?? [];

// Card-ish qualifiers that make a bare "number" token sensitive. "orderNumber" or
// "itemNumber" are ordinary fields; "cardNumber"/"accountNumber"/"panNumber" are not.
const NUMBER_QUALIFIERS = new Set(["card", "account", "pan"]);

// Whole-token match, not substring — a substring test would redact "companyName",
// "panel", "japan", "span", "expansion" (all contain "pan" or "cvc"-adjacent runs
// as bare text) and silently destroy ordinary audit evidence.
const isTokenForbidden = (key: string): boolean => {
  const tokens = tokenize(key);
  if (tokens.some((t) => t === "pan" || t === "cvv" || t === "cvc" || t === "signature")) {
    return true;
  }
  if (tokens.includes("private") && tokens.includes("key")) return true;
  return tokens.some(
    (t, i) => t === "number" && i > 0 && NUMBER_QUALIFIERS.has(tokens[i - 1] ?? ""),
  );
};

// Belt-and-suspenders for separator-less, case-transition-less compounds the
// tokenizer can't split — "CARDNUMBER", "PRIVATEKEY", "TXSIGNATURE" have neither a
// separator nor a case change, so the tokenizer's `[A-Z]+` fallback swallows the
// whole run as one token and the token rules above miss it. Each entry here is
// long enough that no ordinary English field name contains it as a substring —
// that's why bare "pan" is deliberately absent: the token rule already redacts a
// standalone "pan", and adding it here would re-catch "japan"/"expansion".
const HIGH_SIGNAL_SUBSTRINGS = [
  "cvv",
  "cvc",
  "signature",
  "privatekey",
  "cardnumber",
  "accountnumber",
  "pannumber",
  "apikey",
];

const hasHighSignalSubstring = (key: string): boolean => {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return HIGH_SIGNAL_SUBSTRINGS.some((s) => normalized.includes(s));
};

const isForbiddenKey = (key: string): boolean =>
  isTokenForbidden(key) || hasHighSignalSubstring(key);

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
