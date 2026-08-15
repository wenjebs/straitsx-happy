import { useEffect, useRef } from "react";
import styles from "./PurchaseConfirm.module.css";

interface PurchaseConfirmProps {
  itemCount: number;
  total: string;
  /** True when a real backend is configured, i.e. real cards get issued. */
  live: boolean;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The last stop before money moves.
 *
 * Checkout issues one single-use card per item on a rail with no refunds, so it
 * gets an explicit confirmation naming the amount rather than firing straight
 * from the shortlist button. The confirm is submitted once and never retried —
 * a retry here would double-spend.
 */
export function PurchaseConfirm({
  itemCount,
  total,
  live,
  submitting,
  onCancel,
  onConfirm,
}: PurchaseConfirmProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-label="Confirm purchase">
      <div className={styles.dialog}>
        <div className={styles.title}>Authorise {itemCount} purchases?</div>
        <p className={styles.body}>
          Agents will check out each item with its own single-use card, issued at exactly the
          approved amount.
        </p>

        <div className={styles.summary}>
          <span className={styles.total}>{total}</span>
          <span>
            {itemCount} orders · {itemCount} single-use cards
          </span>
        </div>

        <div className={styles.warning}>
          {live
            ? "live rail · real cards, real money, no refunds"
            : "mock issuer · no real cards are issued"}
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={styles.confirm}
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "Placing orders…" : "Authorise & buy"}
          </button>
        </div>
      </div>
    </div>
  );
}
