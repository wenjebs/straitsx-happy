import { appendAudit } from "./audit.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { IssuerAdapter } from "./issuer/types.js";
import { releaseExpired } from "./ledger.js";

export type ReconDeps = {
  db: Db;
  cfg: Config;
  wallet: { authorizationUsed(nonce: `0x${string}`): Promise<boolean> };
  /** Optional: when present, a settled-but-lost payment is recovered by replaying its envelope. */
  issuer?: IssuerAdapter;
};

const iso = () => new Date().toISOString();

export async function resolvePending(deps: ReconDeps) {
  const { db } = deps;
  const rows = db.raw.prepare(`SELECT * FROM payments WHERE state='PENDING'`).all() as any[];
  let settled = 0,
    failed = 0,
    unresolved = 0;

  for (const p of rows) {
    if (Date.parse(p.valid_before) > Date.now()) {
      unresolved++;
      continue;
    }

    const used = /^0x[0-9a-f]{64}$/i.test(p.nonce)
      ? await deps.wallet.authorizationUsed(p.nonce)
      : false;

    if (used) {
      // The money left but we never saw the card. Replaying the stored envelope is safe —
      // the nonce is spent on-chain, so this can only return the card, never pay again.
      let recovered: Awaited<ReturnType<NonNullable<ReconDeps["issuer"]>["send"]>> | null = null;
      let replayFailed = false;
      if (deps.issuer && p.envelope) {
        try {
          recovered = await deps.issuer.send(
            {
              amountCents: p.amount_cents,
              cardholderName: deps.cfg.cardholderName,
              idempotencyKey: p.purchase_id,
            },
            { nonce: p.nonce, envelope: p.envelope, validBeforeMs: Date.parse(p.valid_before) },
          );
        } catch {
          replayFailed = true;
        }
      }
      if (replayFailed) {
        // A transient failure (429, dropped socket, unparsable JSON) is not proof the card
        // doesn't exist. Leave the payment PENDING and write nothing — the next tick retries
        // the replay. Converging late is better than converging wrong (STRANDED is terminal).
        unresolved++;
        continue;
      }
      db.tx((t) => {
        t.raw
          .prepare(`UPDATE payments SET state='SETTLED', tx_hash=? WHERE nonce=?`)
          .run(recovered?.settlementTx ?? null, p.nonce);
        if (recovered) {
          t.raw
            .prepare(
              `UPDATE purchases SET state='CARD_ISSUED', final_cents=?, updated_at=? WHERE id=?`,
            )
            .run(p.amount_cents, iso(), p.purchase_id);
          t.raw
            .prepare(`INSERT OR REPLACE INTO cards VALUES (?,?,?,?,?,?,?)`)
            .run(
              p.purchase_id,
              deps.issuer!.name,
              recovered.opaqueId,
              recovered.last4,
              recovered.expiresAt,
              "ACTIVE",
              iso(),
            );
          appendAudit(t, {
            purchaseId: p.purchase_id,
            kind: "CARD_ISSUED",
            detail: { reason: "recovered_by_envelope_replay" },
          });
        } else {
          t.raw
            .prepare(
              `UPDATE purchases SET state='STRANDED', final_cents=?, updated_at=? WHERE id=?`,
            )
            .run(p.amount_cents, iso(), p.purchase_id);
          appendAudit(t, {
            purchaseId: p.purchase_id,
            kind: "STRANDED",
            detail: { reason: "settled_on_chain_response_lost", amountCents: p.amount_cents },
          });
        }
      });
      settled++;
    } else {
      db.tx((t) => {
        t.raw.prepare(`UPDATE payments SET state='FAILED' WHERE nonce=?`).run(p.nonce);
        t.raw
          .prepare(`UPDATE purchases SET state='FAILED', final_cents=NULL, updated_at=? WHERE id=?`)
          .run(iso(), p.purchase_id);
        appendAudit(t, {
          purchaseId: p.purchase_id,
          kind: "FAILED",
          detail: { reason: "deadline_passed_nonce_unused" },
        });
      });
      failed++;
    }
  }
  return { settled, failed, unresolved };
}

export function startRecon(deps: ReconDeps, intervalMs = 10_000) {
  // Re-entrancy guard: resolvePending awaits a chain read and possibly an issuer.send()
  // replay, and the payments row stays PENDING until the write after that await resolves.
  // Without this, a tick slower than intervalMs would re-select the same PENDING row and
  // call issuer.send() for it again, concurrently — the double-send shape, even though the
  // nonce being single-use on-chain means it can't actually double-pay.
  let running = false;
  // unref so a running reconciler never holds a test worker or a CLI process open
  const timer = setInterval(() => {
    if (!running) {
      running = true;
      void resolvePending(deps)
        .catch(() => {})
        .finally(() => {
          running = false;
        });
    }
    // Fires every tick regardless of whether resolvePending is in flight — it's
    // synchronous and cheap, and skipping it during a long reconciliation would let
    // reservations outlive their TTL.
    releaseExpired(deps.db);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
