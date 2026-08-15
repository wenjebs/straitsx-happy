import type { Activity } from "../lib/Api";
import { formatMinor, hue } from "../state/derive";
import styles from "./ShortlistScreen.module.css";

interface ShortlistScreenProps {
  activity: Activity;
  /** Whole SGD, from the mandate. */
  actCap: number;
  onReject: (itemId: string) => void;
  /** Opens the confirmation — this button never spends directly. */
  onRequestPurchase: () => void;
  submitting: boolean;
}

export function ShortlistScreen({
  activity,
  actCap,
  onReject,
  onRequestPurchase,
  submitting,
}: ShortlistScreenProps) {
  const total = activity.shortlist.reduce((sum, p) => sum + p.listing.amountMinor, 0);
  const headroom = Math.max(0, actCap * 100 - total);
  const sellers = new Set(activity.shortlist.map((pick) => pick.listing.seller)).size;

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <div className="eyebrow">Shortlist</div>
        <h2 className={styles.title}>One pick per item, ready for checkout</h2>
        <p className={styles.lede}>
          {activity.agents.length} scouts browsed verified storefronts live and settled on{" "}
          {sellers} {sellers === 1 ? "seller" : "sellers"}. Reject any pick to swap in the
          runner-up they already opened and priced.
        </p>

        <div className={styles.list}>
          {activity.shortlist.map((pick) => {
            const item = activity.wishlist.find((w) => w.id === pick.itemId);
            if (!item) return null;
            return (
              <div className={styles.row} key={pick.itemId}>
                <div
                  className={styles.image}
                  style={
                    pick.listing.imageUrl
                      ? {
                          backgroundImage: `url(${pick.listing.imageUrl})`,
                          backgroundSize: "cover",
                        }
                      : undefined
                  }
                >
                  {!pick.listing.imageUrl && (
                    <span className={styles.imageLabel}>{item.short.toLowerCase()}</span>
                  )}
                </div>
                <div className={styles.body}>
                  <div className={styles.itemRow}>
                    <span className={styles.dot} style={{ background: hue(item.hueIndex) }} />
                    <span className={styles.itemName}>{item.name}</span>
                  </div>
                  <div className={styles.listingTitle}>{pick.listing.title}</div>
                  <div className={styles.seller}>
                    {pick.listing.seller} · {pick.listing.rating}
                  </div>
                  <p className={styles.why}>{pick.listing.why}</p>
                </div>
                <div className={styles.right}>
                  <div className={styles.price}>{pick.listing.price}</div>
                  <button
                    type="button"
                    className={styles.reject}
                    onClick={() => onReject(pick.itemId)}
                  >
                    {pick.reSearched ? "re-searched" : "Reject & re-search"}
                  </button>
                </div>
              </div>
            );
          })}

          <div className={styles.foot}>
            <div>
              <div className={styles.totalLabel}>Total</div>
              <div className={styles.total}>{formatMinor(total)}</div>
            </div>
            <div className={styles.note}>
              <div>
                cap S${actCap.toLocaleString("en-SG")} / activity · under by {formatMinor(headroom)}
              </div>
              <div>card: single-use XSGD virtual · expires 60 min</div>
            </div>
            <button
              type="button"
              className={styles.confirm}
              onClick={onRequestPurchase}
              disabled={submitting}
            >
              {submitting ? "Placing orders…" : "Confirm & purchase"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
