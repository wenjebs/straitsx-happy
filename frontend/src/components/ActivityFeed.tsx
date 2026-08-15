import type { Activity } from "../lib/Api";
import { flowFraction, statusLabels } from "../state/derive";
import styles from "./ActivityFeed.module.css";
import { Chevrons } from "./Chevrons";

interface ActivityFeedProps {
  activities: Activity[];
  onOpen: (id: string) => void;
  onNew: () => void;
}

export function ActivityFeed({ activities, onOpen, onNew }: ActivityFeedProps) {
  return (
    <aside className={styles.feed}>
      <div className={styles.head}>
        <span className="eyebrow">Activity</span>
        <button
          type="button"
          className={styles.new}
          onClick={onNew}
          title="New activity"
          aria-label="New activity"
        >
          +
        </button>
      </div>

      <div className={styles.list}>
        {activities.map((activity) => (
          <Card key={activity.id} activity={activity} onOpen={() => onOpen(activity.id)} />
        ))}
      </div>
    </aside>
  );
}

function Card({ activity, onOpen }: { activity: Activity; onOpen: () => void }) {
  /*
   * Chip and bar both come from the activity's own status — never from what is
   * currently displayed, or a card can read "drafting" while its bar shows
   * search progress.
   */
  const labels = statusLabels(activity);
  const done = activity.status === "completed";
  const cancelled = activity.status === "cancelled";
  const live = activity.status === "live";

  return (
    <button type="button" onClick={onOpen} className={styles.card}>
      <div className={styles.row}>
        <span
          className={`${styles.dot} ${live ? styles.live : ""} ${
            cancelled ? styles.cancelled : ""
          }`}
        />
        <span className={styles.title}>{activity.title}</span>
      </div>
      <div className={styles.meta}>
        <span
          className={`${styles.chip} ${done ? styles.chipDone : ""} ${
            live ? "" : styles.chipArchived
          } ${cancelled ? styles.chipCancelled : ""}`}
        >
          {labels.chip}
        </span>
        <span className={styles.ts}>{activity.displayTs}</span>
      </div>
      <div className={styles.progress}>
        <Chevrons
          fraction={flowFraction(activity)}
          count={26}
          gap={1.5}
          clip
          {...(cancelled ? { mode: "cancelled" as const } : {})}
        />
        <span className={styles.barLabel}>{labels.bar}</span>
      </div>
    </button>
  );
}
