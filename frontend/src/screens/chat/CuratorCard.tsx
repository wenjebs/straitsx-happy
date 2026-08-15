import type { Activity } from "../../lib/Api";
import { hue } from "../../state/derive";
import type { HappyActions } from "../../state/useHappy";
import styles from "./CuratorCard.module.css";

interface CuratorCardProps {
  itemId: string;
  activity: Activity;
  actions: HappyActions;
}

/** One clarification card per ambiguous item. Choosing locks the option. */
export function CuratorCard({ itemId, activity, actions }: CuratorCardProps) {
  const item = activity.wishlist.find((w) => w.id === itemId);
  const clarification = activity.clarifications.find((c) => c.itemId === itemId);
  if (!item || !clarification) return null;

  const first = clarification.options[0];

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.dot} style={{ background: hue(item.hueIndex) }} />
        <span className={styles.label}>Curator · {item.name}</span>
      </div>

      <div className={styles.grid}>
        {clarification.options.map((option) => {
          const picked = clarification.chosen === option.name;
          return (
            <div key={option.name} className={`${styles.option} ${picked ? styles.chosen : ""}`}>
              <div className={styles.image}>
                {option.imageUrl ? (
                  <img
                    className={styles.photo}
                    src={option.imageUrl}
                    alt={`${option.name} reference`}
                    loading="lazy"
                  />
                ) : (
                  <span className={styles.imageLabel}>{option.imgLabel}</span>
                )}
              </div>
              {option.imageSourceUrl && (
                <a
                  className={styles.credit}
                  href={option.imageSourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={option.imageAttribution ?? "View image source and licence"}
                >
                  {option.imageAttribution ?? "Image source · Wikimedia Commons"}
                </a>
              )}
              <div className={styles.body}>
                <div className={styles.name}>{option.name}</div>
                <div className={styles.range}>{option.range}</div>
                <p className={styles.why}>{option.why}</p>
                <button
                  type="button"
                  className={`${styles.choose} ${picked ? styles.locked : ""}`}
                  onClick={() => void actions.choose(itemId, option.name)}
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
            if (first) void actions.choose(itemId, first.name);
          }}
        >
          You decide
        </button>
      </div>
    </div>
  );
}
