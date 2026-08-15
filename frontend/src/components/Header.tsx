import styles from "./Header.module.css";
import { ChevronLeftIcon } from "./Icons";

interface HeaderProps {
  title: string;
  meta: string;
  showBack: boolean;
  showCancel?: boolean;
  cancelling?: boolean;
  onBack: () => void;
  onCancel?: () => void;
  onProfile: () => void;
}

export function Header({
  title,
  meta,
  showBack,
  showCancel = false,
  cancelling = false,
  onBack,
  onCancel,
  onProfile,
}: HeaderProps) {
  return (
    <header className={styles.header}>
      {showBack && (
        <button type="button" className={styles.back} onClick={onBack}>
          <ChevronLeftIcon />
          <span>Back</span>
        </button>
      )}
      <div className={styles.titleWrap}>
        <div className={styles.title}>{title}</div>
      </div>
      <div className={styles.meta}>{meta}</div>
      <div className={styles.right}>
        {showCancel && onCancel && (
          <button
            type="button"
            className={styles.cancelActivity}
            onClick={onCancel}
            disabled={cancelling}
          >
            {cancelling ? "Cancelling…" : "Cancel activity"}
          </button>
        )}
        <button
          type="button"
          className={styles.avatarButton}
          onClick={onProfile}
          title="Profile"
          aria-label="Profile"
        >
          <span className={styles.avatar}>TL</span>
        </button>
      </div>
    </header>
  );
}
