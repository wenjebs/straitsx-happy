import { appendAudit } from "./audit.js";
import type { Cents, Config } from "./config.js";
import type { Db } from "./db.js";
import type { IssueResult, IssuerAdapter } from "./issuer/types.js";
import { getMandateRow, MandateError, markIssued, markPaying, totals } from "./ledger.js";
import { decide } from "./rules.js";

export type Deps = {
  db: Db;
  cfg: Config;
  issuer: IssuerAdapter;
  wallet: { view(): { balanceCents: Cents; ageMs: number } };
};

const iso = () => new Date().toISOString();

export async function issueCardFor(
  deps: Deps,
  purchaseId: string,
  finalTotalCents: Cents,
): Promise<IssueResult> {
  const { db, cfg, issuer } = deps;

  const existingCard = db.raw
    .prepare(`SELECT * FROM cards WHERE purchase_id=?`)
    .get(purchaseId) as any;
  const existingPayment = db.raw
    .prepare(`SELECT * FROM payments WHERE purchase_id=?`)
    .get(purchaseId) as any;
  if (existingCard) {
    return {
      opaqueId: existingCard.opaque_id,
      last4: existingCard.last4,
      expiresAt: existingCard.expires_at,
      settlementTx: existingPayment?.tx_hash ?? null,
    };
  }
  if (existingPayment && existingPayment.state === "PENDING") {
    throw new Error(
      `purchase ${purchaseId} has an unresolved payment — run reconciliation before retrying`,
    );
  }

  const purchase = db.raw.prepare(`SELECT * FROM purchases WHERE id=?`).get(purchaseId) as any;
  if (!purchase) throw new Error(`unknown purchase ${purchaseId}`);
  if (purchase.state !== "RESERVED")
    throw new Error(`purchase ${purchaseId} is ${purchase.state}, expected RESERVED`);
  if (!purchase.approved)
    throw new Error(`purchase ${purchaseId} needs human approval before issuance`);

  const m = getMandateRow(db);
  const t = totals(db);
  const d = decide(
    {
      amountCents: finalTotalCents,
      merchantHost: purchase.merchant_host,
      quotedCents: purchase.quoted_cents,
    },
    {
      config: cfg,
      now: Date.now(),
      mandate: m
        ? {
            id: m.id,
            status: m.status,
            expiresAtMs: Date.parse(m.expires_at),
            perItemCents: m.per_item_cents,
            dailyCents: m.daily_cents,
            merchants: JSON.parse(m.merchants),
          }
        : null,
      spentCents: t.spentCents,
      reservedCents: t.reservedCents,
      ownReservationCents: purchase.quoted_cents,
      ...(deps.wallet.view() as any),
      balanceCents: deps.wallet.view().balanceCents,
      balanceAgeMs: deps.wallet.view().ageMs,
    },
  );
  if (d.decision === "DENY") throw new MandateError(d.reason, purchaseId);

  const faceCents = finalTotalCents + cfg.cardHeadroomCents;
  const req = {
    amountCents: faceCents,
    cardholderName: cfg.cardholderName,
    idempotencyKey: purchaseId,
  };

  // 1. Sign, but send nothing. Costs no money and produces the two things we must persist.
  const prepared = await issuer.prepare(req);

  // 2. Commit the real nonce and the exact envelope bytes BEFORE anything is sent.
  //    This is the crash-safety hinge: reconciliation identifies the payment on-chain by this
  //    nonce, and recovers a lost response by replaying this envelope. A placeholder here
  //    would make both impossible. Both writes are one transaction — a crash in between
  //    would strand the purchase in PAYING with no payment row and no way out.
  //    (better-sqlite3 nests transactions as savepoints, so markPaying's own tx is fine here.)
  db.tx((t) => {
    markPaying(t, purchaseId, finalTotalCents);
    t.raw
      .prepare(`INSERT INTO payments (nonce, purchase_id, amount_cents, valid_before, envelope, state, tx_hash, created_at)
                   VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        prepared.nonce,
        purchaseId,
        faceCents,
        new Date(prepared.validBeforeMs).toISOString(),
        prepared.envelope,
        "PENDING",
        null,
        iso(),
      );
  });

  // 3. Irreversible.
  const result = await issuer.send(req, prepared);

  // 4. Record the outcome, also in one transaction.
  db.tx((t) => {
    t.raw
      .prepare(`UPDATE payments SET state='SETTLED', tx_hash=? WHERE purchase_id=?`)
      .run(result.settlementTx, purchaseId);
    appendAudit(t, { purchaseId, kind: "SETTLED", detail: { settlementTx: result.settlementTx } });
    markIssued(t, purchaseId, finalTotalCents, {
      issuer: issuer.name,
      opaqueId: result.opaqueId,
      last4: result.last4,
      expiresAt: result.expiresAt,
    });
  });

  return result;
}
