import { EXEC_STEPS } from "../data/catalog";
import type { Activity } from "../lib/Api";
import { formatMinor, hue } from "../state/derive";
import styles from "./ExecutionScreen.module.css";

interface ExecutionScreenProps {
  activity: Activity;
  onNewActivity: () => void;
  onViewWallet: () => void;
}

/**
 * Four steps per item, strictly sequential across items, with the Closer's
 * embeddable browser stream shown whenever its callback supplies one.
 */
export function ExecutionScreen({ activity, onNewActivity, onViewWallet }: ExecutionScreenProps) {
  const done = activity.status === "completed";
  const total = activity.shortlist.reduce((sum, p) => sum + p.listing.amountMinor, 0);
  const count = activity.shortlist.length;
  const streamRow =
    activity.execution.find((row) => row.state === "live" && row.liveStreamUrl) ??
    [...activity.execution].reverse().find((row) => row.liveStreamUrl);
  const streamItem = activity.wishlist.find((item) => item.id === streamRow?.itemId);

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <div className={styles.head}>
          <div>
            <div className="eyebrow">Purchase execution</div>
            <h2 className="screen-title">
              {done ? "All orders placed" : `Buying ${count} items, one card each`}
            </h2>
          </div>
          <div className={styles.headMeta}>
            {done
              ? `completed ${activity.completedAt ?? ""} · ${formatMinor(total)}`
              : "sequential · single-use card per order"}
          </div>
        </div>

        <div className={styles.list}>
          {activity.shortlist.map((pick) => {
            const item = activity.wishlist.find((w) => w.id === pick.itemId);
            const row = activity.execution.find((r) => r.itemId === pick.itemId);
            if (!item) return null;
            const step = row?.step ?? 0;
            const state = row?.state ?? "queued";
            const itemHue = hue(item.hueIndex);

            return (
              <div
                className={`${styles.row} ${state === "live" ? styles.active : ""}`}
                key={pick.itemId}
              >
                <span
                  className={`${styles.dot} ${step > 0 ? styles.dotStarted : ""}`}
                  style={{ background: itemHue }}
                />
                <div className={styles.item}>
                  <div className={styles.itemName}>{item.name}</div>
                  <div className={styles.listingTitle}>{pick.listing.title}</div>
                </div>
                <div className={styles.steps}>
                  <div className={styles.stepLabel}>
                    {state === "purchased"
                      ? "complete"
                      : step <= 0
                        ? "queued"
                        : (EXEC_STEPS[Math.min(3, step - 1)] ?? "queued")}
                  </div>
                  <div className={styles.rail}>
                    <span
                      className={styles.fill}
                      style={{ width: `${(step / 4) * 100}%`, background: itemHue }}
                    />
                  </div>
                </div>
                <span className={styles.price}>{pick.listing.price}</span>
                <span
                  className={`${styles.state} ${
                    state === "purchased"
                      ? styles.statePurchased
                      : state === "live"
                        ? styles.stateLive
                        : ""
                  }`}
                >
                  {state}
                </span>
              </div>
            );
          })}
        </div>

        {streamRow?.liveStreamUrl && (
          <section className={styles.stream} aria-label="Closer agent livestream">
            <div className={styles.streamHead}>
              <div>
                <div className={styles.streamEyebrow}>Closer livestream</div>
                <div className={styles.streamTitle}>{streamItem?.name ?? "Purchase agent"}</div>
              </div>
              <div className={styles.streamAction}>{streamRow.action ?? "working"}</div>
            </div>
            <iframe
              className={styles.streamFrame}
              src={streamRow.liveStreamUrl}
              title={`Closer livestream for ${streamItem?.name ?? "purchase"}`}
              allow="clipboard-read; clipboard-write"
            />
          </section>
        )}

        <div className={styles.log}>
          <div className={styles.logEyebrow}>Agent log</div>
          <div className={styles.logLines}>
            {activity.log.slice(-14).map((line) => (
              <div className={styles.logLine} key={line.id}>
                <span className={styles.logTs}>{line.ts}</span>
                <span className={styles.logTag} style={{ color: hue(line.hueIndex) }}>
                  {line.tag}
                </span>
                <span className={styles.logText}>{line.text}</span>
              </div>
            ))}
          </div>
        </div>

        {done && (
          <div className={styles.done}>
            <div>
              <div className={styles.doneTitle}>All {count} items purchased</div>
              <div className={styles.doneMeta}>
                {formatMinor(total)} charged · {count} single-use cards used · activity moved to
                Completed
              </div>
            </div>
            <button type="button" className={styles.secondary} onClick={onNewActivity}>
              Start another activity
            </button>
            <button type="button" className={styles.primary} onClick={onViewWallet}>
              View in wallet
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
