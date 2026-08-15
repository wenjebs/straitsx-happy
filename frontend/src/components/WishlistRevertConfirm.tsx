import { useEffect, useRef } from "react";
import styles from "./WishlistRevertConfirm.module.css";

interface WishlistRevertConfirmProps {
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function WishlistRevertConfirm({
  submitting,
  onCancel,
  onConfirm,
}: WishlistRevertConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-label="Edit wishlist">
      <div className={styles.dialog}>
        <div className={styles.title}>Return to wishlist editing?</div>
        <p className={styles.body}>
          Happy will revert this chat to the proposed wishlist. Any option selections and
          clarification messages after that point will be discarded.
        </p>
        <div className={styles.warning}>The saved wishlist items will remain editable.</div>
        <div className={styles.actions}>
          <button
            type="button"
            ref={cancelRef}
            className={styles.cancel}
            onClick={onCancel}
            disabled={submitting}
          >
            Keep selections
          </button>
          <button
            type="button"
            className={styles.confirm}
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "Reverting…" : "Revert & edit"}
          </button>
        </div>
      </div>
    </div>
  );
}
