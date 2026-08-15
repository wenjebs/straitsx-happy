import { activeItems } from "../../state/derive";
import type { HappyState } from "../../state/types";
import type { Action } from "../../state/useHappy";
import styles from "./WishlistCard.module.css";

interface WishlistCardProps {
  state: HappyState;
  dispatch: React.Dispatch<Action>;
}

/** Goal decomposition: the proposed wishlist, editable before approval. */
export function WishlistCard({ state, dispatch }: WishlistCardProps) {
  const items = activeItems(state);

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.headTitle}>Proposed wishlist</span>
        <span className={styles.budget}>
          {`est. S$1,285 · cap S$${state.actCap.toLocaleString("en-SG")}`}
        </span>
      </div>

      {items.map((item) => (
        <div className={styles.row} key={item.id}>
          <span className={styles.dot} style={{ background: item.hue }} />
          <div className={styles.rowBody}>
            <div className={styles.name}>
              {item.name} — {item.spec.split(",")[0]}
            </div>
            <div className={styles.spec}>{item.spec}</div>
          </div>
          <span className={styles.amount}>{item.budget}</span>
          {state.editing && (
            <button
              type="button"
              className={styles.remove}
              title={`Remove ${item.name}`}
              aria-label={`Remove ${item.name}`}
              onClick={() => dispatch({ type: "removeItem", id: item.id })}
            >
              ×
            </button>
          )}
        </div>
      ))}

      <div className={styles.foot}>
        {state.editing && (
          <>
            <input
              className={styles.addInput}
              value={state.newItem}
              onChange={(e) => dispatch({ type: "setNewItem", value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") dispatch({ type: "addItem" });
              }}
              placeholder="Add an item, e.g. 240mm AIO cooler"
              aria-label="Add an item"
            />
            <button
              type="button"
              className={styles.secondary}
              onClick={() => dispatch({ type: "addItem" })}
            >
              Add
            </button>
          </>
        )}
        <button
          type="button"
          className={styles.secondary}
          onClick={() => dispatch({ type: "toggleEditing" })}
        >
          {state.editing ? "Done editing" : "Edit list"}
        </button>
        <button
          type="button"
          className={styles.primary}
          onClick={() => dispatch({ type: "approveWishlist" })}
        >
          Approve &amp; continue
        </button>
      </div>
    </div>
  );
}
