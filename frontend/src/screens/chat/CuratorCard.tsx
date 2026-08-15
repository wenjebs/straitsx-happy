import { CURATOR, ITEMS, type ItemId } from "../../data/catalog";
import type { HappyState } from "../../state/types";
import type { Action } from "../../state/useHappy";
import styles from "./CuratorCard.module.css";

interface CuratorCardProps {
  itemId: ItemId;
  state: HappyState;
  dispatch: React.Dispatch<Action>;
}

/** One clarification card per ambiguous item. Choosing locks the option. */
export function CuratorCard({ itemId, state, dispatch }: CuratorCardProps) {
  const item = ITEMS.find((i) => i.id === itemId);
  const options = CURATOR[itemId];
  if (!item || !options) return null;

  const first = options[0];

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.dot} style={{ background: item.hue }} />
        <span className={styles.label}>Curator · {item.name}</span>
      </div>

      <div className={styles.grid}>
        {options.map((option) => {
          const picked = state.chosen[itemId] === option.name;
          return (
            <div key={option.name} className={`${styles.option} ${picked ? styles.chosen : ""}`}>
              <div className={styles.image}>
                <span className={styles.imageLabel}>{option.imgLabel}</span>
              </div>
              <div className={styles.body}>
                <div className={styles.name}>{option.name}</div>
                <div className={styles.range}>{option.range}</div>
                <p className={styles.why}>{option.why}</p>
                <button
                  type="button"
                  className={`${styles.choose} ${picked ? styles.locked : ""}`}
                  onClick={() => dispatch({ type: "pick", itemId, option: option.name })}
                >
                  {picked ? "Locked" : "Choose"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.ghost}>
          Ask a follow-up
        </button>
        <button
          type="button"
          className={styles.ghost}
          onClick={() => {
            if (first) dispatch({ type: "pick", itemId, option: first.name });
          }}
        >
          You decide
        </button>
      </div>
    </div>
  );
}
