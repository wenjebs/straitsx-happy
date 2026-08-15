import { money } from "../data/catalog";
import { activeItems, listingFor, shortlistTotal } from "../state/derive";
import type { HappyState } from "../state/types";
import type { Action } from "../state/useHappy";
import styles from "./ShortlistScreen.module.css";

interface ShortlistScreenProps {
  state: HappyState;
  dispatch: React.Dispatch<Action>;
}

export function ShortlistScreen({ state, dispatch }: ShortlistScreenProps) {
  const items = activeItems(state);
  const total = shortlistTotal(state);

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <div className="eyebrow">Shortlist</div>
        <h2 className={styles.title}>One pick per item, ready for checkout</h2>
        <p className={styles.lede}>
          Agents compared 214 listings across 9 sellers. Reject any pick to send its agents back
          out.
        </p>

        <div className={styles.list}>
          {items.map((item) => {
            const listing = listingFor(state, item.id);
            const rejected = state.rejected[item.id] === true;
            return (
              <div className={styles.row} key={item.id}>
                <div className={styles.image}>
                  <span className={styles.imageLabel}>{item.short.toLowerCase()}</span>
                </div>
                <div className={styles.body}>
                  <div className={styles.itemRow}>
                    <span className={styles.dot} style={{ background: item.hue }} />
                    <span className={styles.itemName}>{item.name}</span>
                  </div>
                  <div className={styles.listingTitle}>{listing.title}</div>
                  <div className={styles.seller}>
                    {listing.seller} · {listing.rating}
                  </div>
                  <p className={styles.why}>{listing.why}</p>
                </div>
                <div className={styles.right}>
                  <div className={styles.price}>{listing.price}</div>
                  <button
                    type="button"
                    className={styles.reject}
                    onClick={() => dispatch({ type: "reject", id: item.id })}
                  >
                    {rejected ? "re-searched" : "Reject & re-search"}
                  </button>
                </div>
              </div>
            );
          })}

          <div className={styles.foot}>
            <div>
              <div className={styles.totalLabel}>Total</div>
              <div className={styles.total}>{money(total)}</div>
            </div>
            <div className={styles.note}>
              <div>
                cap S${state.actCap.toLocaleString("en-SG")} / activity · under by{" "}
                {money(Math.max(0, state.actCap - total))}
              </div>
              <div>card: single-use XSGD virtual · expires 60 min</div>
            </div>
            <button
              type="button"
              className={styles.confirm}
              onClick={() => dispatch({ type: "confirmPurchase" })}
            >
              Confirm &amp; purchase
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
