import { ACTIVITY_TITLE, type ArchiveId, PAST_ACTIVITIES } from "../data/catalog";
import { effectiveStage, flowFraction } from "../state/derive";
import type { HappyState } from "../state/types";
import styles from "./ActivityFeed.module.css";
import { Chevrons } from "./Chevrons";

interface ActivityFeedProps {
  state: HappyState;
  onOpenCurrent: () => void;
  onOpenArchive: (id: ArchiveId) => void;
  onNew: () => void;
}

const LIVE_LABEL: Record<string, string> = {
  search: "searching…",
  shortlist: "awaiting you…",
  exec: "purchasing…",
};

const LIVE_CHIP: Record<string, string> = {
  search: "searching",
  shortlist: "awaiting you",
  exec: "purchasing",
};

export function ActivityFeed({ state, onOpenCurrent, onOpenArchive, onNew }: ActivityFeedProps) {
  /*
   * The chip and the bar are both computed from the effective stage — the
   * running activity's own stage, which survives leaving the screen. Deriving
   * either from the displayed view lets a card read "drafting" while its bar
   * shows search progress.
   */
  const stage = effectiveStage(state);
  const fraction = flowFraction(state);
  const showCurrent = state.activityLive || state.activityDone;
  const onPurchase = state.screen === "purchase";

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
        {showCurrent && (
          <button
            type="button"
            onClick={onOpenCurrent}
            className={`${styles.card} ${onPurchase ? styles.current : ""}`}
          >
            <div className={styles.row}>
              <span className={`${styles.dot} ${state.activityDone ? "" : styles.live}`} />
              <span className={styles.title}>{ACTIVITY_TITLE}</span>
            </div>
            <div className={styles.meta}>
              <span className={`${styles.chip} ${state.activityDone ? styles.chipDone : ""}`}>
                {state.activityDone ? "completed" : (LIVE_CHIP[stage] ?? "drafting")}
              </span>
              <span className={styles.ts}>{state.activityDone ? "14:41" : "now"}</span>
            </div>
            <div className={styles.progress}>
              <Chevrons fraction={fraction} count={26} gap={1.5} clip />
              <span className={styles.barLabel}>
                {state.activityDone ? "complete" : (LIVE_LABEL[stage] ?? "drafting…")}
              </span>
            </div>
          </button>
        )}

        {PAST_ACTIVITIES.map((activity) => {
          const cancelled = activity.state === "cancelled";
          return (
            <button
              type="button"
              key={activity.id}
              onClick={() => onOpenArchive(activity.id)}
              className={styles.card}
            >
              <div className={styles.row}>
                <span className={`${styles.dot} ${cancelled ? styles.cancelled : ""}`} />
                <span className={styles.title}>{activity.title}</span>
              </div>
              <div className={styles.meta}>
                <span
                  className={`${styles.chip} ${styles.chipArchived} ${
                    cancelled ? styles.chipCancelled : ""
                  }`}
                >
                  {activity.state}
                </span>
                <span className={styles.ts}>{activity.ts}</span>
              </div>
              <div className={styles.progress}>
                <Chevrons
                  fraction={activity.frac}
                  count={26}
                  gap={1.5}
                  clip
                  {...(cancelled ? { mode: "cancelled" as const } : {})}
                />
                <span className={styles.barLabel}>
                  {cancelled ? "stopped at shortlist" : "complete"}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
