import { EXEC_STEPS, money } from "../data/catalog";
import { activeItems, listingFor, shortlistTotal } from "../state/derive";
import type { HappyState } from "../state/types";
import type { Action } from "../state/useHappy";
import styles from "./ExecutionScreen.module.css";

interface ExecutionScreenProps {
  state: HappyState;
  dispatch: React.Dispatch<Action>;
}

/**
 * The same observable language as the search screen, simpler: no video tiles.
 * Four steps per item, strictly sequential across items.
 */
export function ExecutionScreen({ state, dispatch }: ExecutionScreenProps) {
  const items = activeItems(state);
  const total = shortlistTotal(state);

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <div className={styles.head}>
          <div>
            <div className="eyebrow">Purchase execution</div>
            <h2 className="screen-title">
              {state.activityDone
                ? "All orders placed"
                : `Buying ${items.length} items, one card each`}
            </h2>
          </div>
          <div className={styles.headMeta}>
            {state.activityDone
              ? `completed 14:41 · ${money(total)}`
              : "sequential · single-use card per order"}
          </div>
        </div>

        <div className={styles.list}>
          {items.map((item, index) => {
            const listing = listingFor(state, item.id);
            /* Steps elapsed for this item: <=0 queued, 1..3 live, >=4 done. */
            const rel = state.execStep - index * 4;
            const active = rel > 0 && rel < 4;
            const done = rel >= 4;
            const stepIndex = Math.max(0, Math.min(3, rel - 1));
            const width = done ? 100 : rel <= 0 ? 0 : (rel / 4) * 100;

            return (
              <div className={`${styles.row} ${active ? styles.active : ""}`} key={item.id}>
                <span
                  className={`${styles.dot} ${rel > 0 ? styles.dotStarted : ""}`}
                  style={{ background: item.hue }}
                />
                <div className={styles.item}>
                  <div className={styles.itemName}>{item.name}</div>
                  <div className={styles.listingTitle}>{listing.title}</div>
                </div>
                <div className={styles.steps}>
                  <div className={styles.stepLabel}>
                    {done ? "complete" : rel <= 0 ? "queued" : EXEC_STEPS[stepIndex]}
                  </div>
                  <div className={styles.rail}>
                    <span
                      className={styles.fill}
                      style={{ width: `${width}%`, background: item.hue }}
                    />
                  </div>
                </div>
                <span className={styles.price}>{listing.price}</span>
                <span
                  className={`${styles.state} ${
                    done ? styles.statePurchased : active ? styles.stateLive : ""
                  }`}
                >
                  {done ? "purchased" : active ? "live" : "queued"}
                </span>
              </div>
            );
          })}
        </div>

        <div className={styles.log}>
          <div className={styles.logEyebrow}>Agent log</div>
          <div className={styles.logLines}>
            {state.log.slice(-14).map((line) => (
              <div className={styles.logLine} key={`${line.ts}-${line.short}-${line.text}`}>
                <span className={styles.logTs}>{line.ts}</span>
                <span className={styles.logTag} style={{ color: line.hue }}>
                  {line.short}
                </span>
                <span className={styles.logText}>{line.text}</span>
              </div>
            ))}
          </div>
        </div>

        {state.activityDone && (
          <div className={styles.done}>
            <div>
              <div className={styles.doneTitle}>All {items.length} items purchased</div>
              <div className={styles.doneMeta}>
                {money(total)} charged · {items.length} single-use cards expired · activity moved to
                Completed
              </div>
            </div>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => dispatch({ type: "newActivity" })}
            >
              Start another activity
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={() => dispatch({ type: "goScreen", screen: "wallet" })}
            >
              View in wallet
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
