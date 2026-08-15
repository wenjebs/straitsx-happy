import { CURATOR, ITEMS, type ItemId } from "../../data/catalog";
import type { HappyState } from "../../state/types";
import type { Action } from "../../state/useHappy";
import styles from "./LockedPanel.module.css";

interface LockedPanelProps {
  state: HappyState;
  dispatch: React.Dispatch<Action>;
}

/** Locked items accumulate visibly, then the run is dispatched. */
export function LockedPanel({ state, dispatch }: LockedPanelProps) {
  const locked = Object.keys(state.chosen).flatMap((key) => {
    const id = key as ItemId;
    const item = ITEMS.find((i) => i.id === id);
    const option = CURATOR[id]?.find((o) => o.name === state.chosen[id]);
    return item && option ? [{ item, option }] : [];
  });

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.eyebrow}>Locked items</div>
        <div className={styles.list}>
          {locked.map(({ item, option }) => (
            <div className={styles.row} key={item.id}>
              <span className={styles.dot} style={{ background: item.hue }} />
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
        onClick={() => dispatch({ type: "startSearch" })}
      >
        Dispatch agents
      </button>
    </>
  );
}
