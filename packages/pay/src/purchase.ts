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

  // I2: headroom is threaded through decide()/markPaying/markIssued inconsistently — decide()
  // and both ledger writes record finalTotalCents while the wallet is actually debited
  // finalTotalCents + headroom. Rather than thread the extra amount through three call sites,
  // refuse to operate at all while headroom is non-zero. Dormant today since the default is 0.
  if (cfg.cardHeadroomCents !== 0) {
    throw new Error(
      `cardHeadroomCents=${cfg.cardHeadroomCents} is not implemented — issueCardFor only supports 0 headroom`,
    );
  }

  const purchase = db.raw.prepare(`SELECT * FROM purchases WHERE id=?`).get(purchaseId) as any;
  if (!purchase) throw new Error(`unknown purchase ${purchaseId}`);

  const existingCard = db.raw
    .prepare(`SELECT * FROM cards WHERE purchase_id=?`)
    .get(purchaseId) as any;
  const existingPayment = db.raw
    .prepare(`SELECT * FROM payments WHERE purchase_id=?`)
    .get(purchaseId) as any;
  // I4: gate on the purchase actually having reached CARD_ISSUED — a cancelled purchase
  // (STRANDED, card DEAD) must not report its dead card back as a normal success.
  if (existingCard && purchase.state === "CARD_ISSUED") {
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

  if (purchase.state !== "RESERVED")
    throw new Error(`purchase ${purchaseId} is ${purchase.state}, expected RESERVED`);
  if (!purchase.approved)
    throw new Error(`purchase ${purchaseId} needs human approval before issuance`);

  const m = getMandateRow(db);
  const t = totals(db, m?.id ?? null);
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
  // C1: purchase.approved is frozen at reserve time off the *quoted* amount — it only proves a
  // human (or an auto-approval) blessed that quote, not this final total. A quote that was
  // ALLOW at reserve time can still land in NEEDS_HUMAN once re-decided against the final total
  // (e.g. a merchant nudging the price up within tolerance but over the per-item cap, or the
  // mandate being tightened between reserve and issue). Require an explicit APPROVED audit event
  // for this purchase before proceeding — approvePurchase() is what writes it.
  if (d.decision === "NEEDS_HUMAN") {
    const approvedEvent = db.raw
      .prepare(`SELECT 1 FROM audit_events WHERE purchase_id=? AND kind='APPROVED'`)
      .get(purchaseId);
    if (!approvedEvent) {
      throw new Error(`purchase ${purchaseId} needs human approval before issuance (${d.reason})`);
    }
  }

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
