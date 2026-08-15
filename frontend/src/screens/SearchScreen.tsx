import type { Activity, AgentState, ItemProgress, WishlistItem } from "../lib/Api";
import { hue, movedBackward, progressFor, STAGE_LABELS, stageLabel } from "../state/derive";
import styles from "./SearchScreen.module.css";

interface SearchScreenProps {
  activity: Activity;
  elapsed: number;
  onTogglePlay: () => void;
}

/** Lets a lane pass its shared transition string down as a custom property. */
type CSSVars = React.CSSProperties & Record<`--${string}`, string>;

/*
 * Forward is quick and decisive; backward is slower, with anticipation and
 * overshoot, because an item looping from Gathering back to Discovering — an
 * agent checking another candidate listing before it has enough to compare —
 * must read as deliberate rather than as a glitch.
 */
const FORWARD = "left 850ms cubic-bezier(.22,.61,.36,1)";
const BACKWARD = "left 1450ms cubic-bezier(.7,-0.4,.3,1.4)";

/** Nudges the dot left by its own width as it approaches the far end. */
function offsetLeft(pct: number): string {
  return `calc(${pct}% - ${(pct / 100) * 11}px)`;
}

export function SearchScreen({ activity, elapsed, onTogglePlay }: SearchScreenProps) {
  const items = activity.wishlist;

  return (
    <div className={styles.screen}>
      <div className={styles.head}>
        <div>
          <div className="eyebrow">Multi-agent search</div>
          <h2 className="screen-title">{activity.title}</h2>
        </div>
        <div className={styles.headMeta}>
          <span>
            {items.length} items · {activity.agents.length} agents
          </span>
          <span>t+{elapsed}s</span>
          <span className={styles.run}>
            <span className={styles.runDot} />
            {activity.searchPlaying ? "live" : "paused"}
          </span>
          <button type="button" className={styles.playToggle} onClick={onTogglePlay}>
            {activity.searchPlaying ? "pause" : "resume"}
          </button>
        </div>
      </div>

      <div className={styles.track}>
        <div className={styles.trackScroll}>
          <div className={styles.trackInner}>
            <div className={styles.stops}>
              {STAGE_LABELS.map((label, i) => (
                <div
                  key={label}
                  className={`${styles.stop} ${
                    i === 0
                      ? styles.stopFirst
                      : i === STAGE_LABELS.length - 1
                        ? styles.stopLast
                        : ""
                  }`}
                >
                  {label}
                </div>
              ))}
            </div>

            <div className={styles.rule}>
              {STAGE_LABELS.map((label, i) => (
                <span
                  key={label}
                  className={styles.tick}
                  style={{ left: `calc(${(i / 4) * 100}% - ${(i / 4) * 2}px)` }}
                />
              ))}
            </div>

            {items.map((item) => (
              <Lane key={item.id} item={item} progress={progressFor(activity, item.id)} />
            ))}
          </div>
        </div>

        <div className={styles.legend}>
          {items.map((item) => {
            const progress = progressFor(activity, item.id);
            return (
              <div className={styles.legendItem} key={item.id}>
                <span className={styles.legendChip} style={{ background: hue(item.hueIndex) }} />
                <span className={styles.legendName}>{item.name}</span>
                <span className={styles.legendStage}>
                  {!progress || progress.queued
                    ? "queued"
                    : stageLabel(progress.stage).toLowerCase()}
                </span>
                {movedBackward(progress) && <span className={styles.recheck}>re-check ↩</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.tiles}>
        {activity.agents.map((agent) => {
          const item = items.find((w) => w.id === agent.itemId);
          return item ? <AgentTile key={agent.agentId} agent={agent} item={item} /> : null;
        })}
      </div>
    </div>
  );
}

function Lane({ item, progress }: { item: WishlistItem; progress: ItemProgress | undefined }) {
  const stage = progress?.stage ?? 0;
  const queued = progress?.queued ?? true;
  const back = movedBackward(progress);
  const pct = (stage / 4) * 100;
  const itemHue = hue(item.hueIndex);

  /*
   * One string, shared verbatim by the dot and its label. Giving them separate
   * durations desynchronises label from dot mid-flight and the motion stops
   * reading, so they read the same custom property rather than each declaring
   * their own.
   */
  const lane: CSSVars = { "--move": back ? BACKWARD : FORWARD };

  return (
    <div className={styles.lane} style={lane}>
      <span
        className={`${styles.dot} ${queued ? styles.queued : ""}`}
        style={{
          left: offsetLeft(pct),
          /* Queued dots take the class's white fill instead. */
          ...(queued ? {} : { background: itemHue }),
          boxShadow: back ? `0 0 0 5px color-mix(in oklab, ${itemHue} 22%, transparent)` : "none",
        }}
      />
      <span
        className={`${styles.tag} ${pct > 70 ? styles.tagFlipped : ""} ${
          queued ? styles.tagQueued : ""
        }`}
        style={{ left: offsetLeft(pct), ...(queued ? {} : { color: itemHue }) }}
      >
        {item.short}
      </span>
    </div>
  );
}

function AgentTile({ agent, item }: { agent: AgentState; item: WishlistItem }) {
  const itemHue = hue(item.hueIndex);

  return (
    <div
      className={`${styles.tile} ${agent.queued ? styles.tileQueued : ""}`}
      style={{ borderColor: itemHue }}
    >
      <div className={styles.viewport}>
        <div className={styles.chrome}>
          <span className={styles.chromeChip} style={{ background: itemHue }} />
          <span className={styles.url}>{agent.url}</span>
        </div>

        {agent.liveStreamUrl ? (
          /*
           * The backend serves this as MJPEG, so an <img> is the whole player — the browser
           * swaps each frame in as it arrives. It is an image, not a document, which is why
           * there is no iframe and nothing to sandbox.
           */
          <img
            className={styles.liveFrame}
            src={agent.liveStreamUrl}
            alt={`Live browser view for ${agent.agentId}`}
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className={styles.streamWaiting}>starting browser session…</div>
        )}
      </div>

      <div className={styles.tileFoot}>
        <div className={styles.tileFootRow}>
          <span className={styles.agentId}>{agent.agentId}</span>
          <span className={styles.agentStage}>
            {agent.queued ? "queued" : stageLabel(agent.stage).toLowerCase()}
          </span>
        </div>
        <div className={styles.agentAction}>
          {item.name} · {agent.action}
        </div>
      </div>
    </div>
  );
}
