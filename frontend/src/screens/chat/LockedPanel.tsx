import type { Activity } from "../../lib/Api";
import { hue } from "../../state/derive";
import type { HappyActions } from "../../state/useHappy";
import styles from "./LockedPanel.module.css";

interface LockedPanelProps {
  activity: Activity;
  actions: HappyActions;
}

/** Locked items accumulate visibly, then the run is dispatched. */
export function LockedPanel({ activity, actions }: LockedPanelProps) {
  const locked = activity.clarifications.flatMap((clarification) => {
    const item = activity.wishlist.find((w) => w.id === clarification.itemId);
    const option = clarification.options.find((o) => o.name === clarification.chosen);
    return item && option ? [{ item, option }] : [];
  });

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.eyebrow}>Locked items</div>
        <div className={styles.list}>
          {locked.map(({ item, option }) => (
            <div className={styles.row} key={item.id}>
              <span className={styles.dot} style={{ background: hue(item.hueIndex) }} />
              <span className={styles.name}>
                {item.name} · {option.name}
              </span>
              <span className={styles.range}>{option.range}</span>
            </div>
          ))}
        </div>
      </div>
      <button
        type="button"
        className={styles.dispatch}
        onClick={() => void actions.dispatchAgents()}
      >
        Dispatch agents
      </button>
    </>
  );
}
