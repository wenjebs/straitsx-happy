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
        {activity.agents.map((agent, index) => {
          const item = items.find((w) => w.id === agent.itemId);
          return item ? (
            <AgentTile key={agent.agentId} agent={agent} item={item} index={index} />
          ) : null;
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

function AgentTile({
  agent,
  item,
  index,
}: {
  agent: AgentState;
  item: WishlistItem;
  index: number;
}) {
  const itemHue = hue(item.hueIndex);
  /* Every third tile mocks a result grid; the rest mock a scrolling page. */
  const isGrid = index % 3 === 2;

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

        {isGrid ? (
          <div className={styles.grid}>
            {Array.from({ length: 9 }, (_, c) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative grid
                key={c}
                className={styles.cell}
                style={{
                  background: c % 4 === 0 ? "#e4e4e8" : "#f1f1f3",
                  animation: `h-shimmer ${2 + (c % 3) * 0.4}s ease-in-out infinite`,
                  animationDelay: `${c * 0.12}s`,
                }}
              />
            ))}
          </div>
        ) : (
          <div
            className={styles.scroller}
            style={{ animation: `h-scroll ${7 + (index % 3)}s linear infinite` }}
          >
            {Array.from({ length: 18 }, (_, r) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative bars
                key={r}
                className={styles.scrollBar}
                style={{
                  height: r % 5 === 0 ? 7 : 4,
                  width: `${48 + ((r * 37) % 52)}%`,
                  background: r % 5 === 0 ? "#dcdce0" : "#eeeef0",
                }}
              />
            ))}
          </div>
        )}

        <div className={styles.fade} />
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
