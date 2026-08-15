import type { Activity } from "../../lib/Api";
import { hue } from "../../state/derive";
import type { HappyState } from "../../state/types";
import type { HappyActions } from "../../state/useHappy";
import styles from "./WishlistCard.module.css";

interface WishlistCardProps {
  activity: Activity;
  state: HappyState;
  actions: HappyActions;
}

/** Goal decomposition: the proposed wishlist, editable before approval. */
export function WishlistCard({ activity, state, actions }: WishlistCardProps) {
  const cap = state.mandate?.actCap ?? 2500;
  const editable = activity.stage === "wishlist";

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.headTitle}>Proposed wishlist</span>
        <span className={styles.budget}>
          {`${activity.wishlistEstimate} · cap S$${cap.toLocaleString("en-SG")}`}
        </span>
      </div>

      {activity.wishlist.map((item) => (
        <div className={styles.row} key={item.id}>
          <span className={styles.dot} style={{ background: hue(item.hueIndex) }} />
          <div className={styles.rowBody}>
            <div className={styles.name}>
              {item.name} — {item.spec.split(",")[0]}
            </div>
            <div className={styles.spec}>{item.spec}</div>
          </div>
          <span className={styles.amount}>{item.budget}</span>
          {editable && state.editing && (
            <button
              type="button"
              className={styles.remove}
              title={`Remove ${item.name}`}
              aria-label={`Remove ${item.name}`}
              onClick={() => void actions.removeItem(item.id)}
            >
              ×
            </button>
          )}
        </div>
      ))}

      <div className={styles.foot}>
        {editable && state.editing && (
          <>
            <input
              className={styles.addInput}
              value={state.newItem}
              onChange={(e) => actions.setNewItem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void actions.addItem();
              }}
              placeholder="Add an item, e.g. 240mm AIO cooler"
              aria-label="Add an item"
            />
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void actions.addItem()}
            >
              Add
            </button>
          </>
        )}
        <button
          type="button"
          className={styles.secondary}
          onClick={editable ? actions.toggleEditing : actions.requestWishlistEdit}
        >
          {editable && state.editing ? "Done editing" : "Edit list"}
        </button>
        {editable && (
          <button
            type="button"
            className={styles.primary}
            onClick={() => void actions.approveWishlist()}
          >
            Approve &amp; continue
          </button>
        )}
      </div>
    </div>
  );
}
