import type { Activity } from "../../lib/Api";
import { hue } from "../../state/derive";
import type { HappyActions } from "../../state/useHappy";
import styles from "./LockedPanel.module.css";

interface LockedPanelProps {
  activity: Activity;
  actions: HappyActions;
}

/** Every approved wishlist item stays visible before the run is dispatched. */
export function LockedPanel({ activity, actions }: LockedPanelProps) {
  const ready = activity.wishlist.map((item) => {
    const clarification = activity.clarifications.find((row) => row.itemId === item.id);
    const option = clarification?.options.find((row) => row.name === clarification.chosen);
    return {
      item,
      detail: option?.name ?? item.spec,
      range: option?.range || item.budget,
    };
  });

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.eyebrow}>Items ready for search</div>
        <div className={styles.list}>
          {ready.map(({ item, detail, range }) => (
            <div className={styles.row} key={item.id}>
              <span className={styles.dot} style={{ background: hue(item.hueIndex) }} />
              <span className={styles.name}>
                {item.name} · {detail}
              </span>
              <span className={styles.range}>{range}</span>
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
