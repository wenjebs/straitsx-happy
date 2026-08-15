import { Chevrons } from "../components/Chevrons";
import type { Activity } from "../lib/Api";
import { formatMinor } from "../state/derive";
import styles from "./ArchiveScreen.module.css";

interface ArchiveScreenProps {
  activity: Activity;
  historyLoading: boolean;
  onViewHistory: () => void;
}

/** A focused past activity: summary bar over its line items. */
export function ArchiveScreen({ activity, historyLoading, onViewHistory }: ArchiveScreenProps) {
  const cancelled = activity.status === "cancelled";
  const lines = activity.archiveLines ?? [];

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <div className="eyebrow">{activity.status} activity</div>
        <h2 className={styles.title}>{activity.title}</h2>

        <div className={styles.summary}>
          <Chevrons
            fraction={cancelled ? 0.45 : 1}
            count={40}
            gap={2}
            wrap
            {...(cancelled ? { mode: "cancelled" as const } : {})}
          />
          <div className={styles.summaryMeta}>
            <span>{cancelled ? `cancelled during ${activity.stage}` : "all items purchased"}</span>
            <span className={styles.total}>{formatMinor(activity.totalMinor)}</span>
          </div>
        </div>

        <div className={styles.list}>
          {lines.map((line) => (
            <div className={styles.row} key={line.name}>
              <div className={styles.lineBody}>
                <div className={styles.name}>{line.name}</div>
                <div className={styles.seller}>{line.seller}</div>
              </div>
              <span className={styles.price}>{line.price}</span>
            </div>
          ))}
          {lines.length === 0 && (
            <div className={styles.empty}>No completed purchases were recorded.</div>
          )}
        </div>

        <button
          type="button"
          className={styles.historyButton}
          onClick={onViewHistory}
          disabled={historyLoading}
        >
          {historyLoading ? "Loading history…" : "View activity history"}
        </button>
      </div>
    </div>
  );
}
