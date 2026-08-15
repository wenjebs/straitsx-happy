import { useEffect, useRef } from "react";
import styles from "./ActivityCancelConfirm.module.css";

interface ActivityCancelConfirmProps {
  duringCheckout: boolean;
  submitting: boolean;
  onDismiss: () => void;
  onConfirm: () => void;
}

export function ActivityCancelConfirm({
  duringCheckout,
  submitting,
  onDismiss,
  onConfirm,
}: ActivityCancelConfirmProps) {
  const dismissRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    dismissRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss, submitting]);

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-label="Cancel activity">
      <div className={styles.dialog}>
        <div className={styles.title}>Cancel this activity?</div>
        <p className={styles.body}>
          Happy will stop planning, searching, or checkout work and reject any agent updates that
          arrive after cancellation.
        </p>
        <div className={styles.warning}>
          {duringCheckout
            ? "Any order already submitted to a merchant may still complete and is not reversed by cancellation. Unused card access will be invalidated."
            : "The activity will remain in your history as cancelled and cannot be resumed."}
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            ref={dismissRef}
            className={styles.dismiss}
            onClick={onDismiss}
            disabled={submitting}
          >
            Keep activity
          </button>
          <button
            type="button"
            className={styles.confirm}
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "Cancelling…" : "Cancel activity"}
          </button>
        </div>
      </div>
    </div>
  );
}
