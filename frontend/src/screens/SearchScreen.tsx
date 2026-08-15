import { useEffect, useRef } from "react";
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
  const live = streamingAgents(activity);
  const waiting = activity.agents.length - live.length;

  return (
    <div className={styles.screen}>
      <div className={styles.head}>
        <div>
          <div className="eyebrow">Multi-agent search</div>
          <h2 className="screen-title">{activity.title}</h2>
        </div>
        <div className={styles.headMeta}>
          <span>
            {items.length} items · {live.length} browsing
            {waiting > 0 ? ` · ${waiting} waiting` : ""}
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

      <ScoutLog activity={activity} />

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

      <AgentTiles activity={activity} />
    </div>
  );
}

/**
 * The search narration, oldest to newest.
 *
 * Web search is plain HTTP to OpenAI, so it starts for every item at once and finishes long before
 * a browser session is free — it has no tile of its own to move, and this is where it reports. The
 * browsers write their steps here too, so one column tells the whole story instead of a dozen tiles
 * each overwriting their own last line.
 */
function ScoutLog({ activity }: { activity: Activity }) {
  const scroller = useRef<HTMLDivElement>(null);
  const lines = activity.log;

  useEffect(() => {
    const node = scroller.current;
    if (node && lines.length > 0) node.scrollTop = node.scrollHeight;
  }, [lines.length]);

  return (
    <div className={styles.feed}>
      <div className={styles.feedHead}>
        <span className={styles.feedDot} />
        <span className={styles.feedTitle}>Web search · scout log</span>
        <span className={styles.feedCount}>
          {lines.length === 0 ? "starting" : `${lines.length} events`}
        </span>
      </div>
      <div className={styles.feedScroll} ref={scroller}>
        {lines.length === 0 ? (
          <div className={styles.feedEmpty}>querying the verified storefronts…</div>
        ) : (
          lines.map((line) => (
            <div className={styles.feedLine} key={line.id}>
              <span className={styles.feedAt}>{line.ts}</span>
              <span className={styles.feedChip} style={{ background: hue(line.hueIndex) }} />
              <span className={styles.feedShort}>{line.tag}</span>
              <span className={styles.feedAction}>{line.text}</span>
            </div>
          ))
        )}
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

/**
 * A tile exists to show a browser. Until a scout has a livestream it has no picture, only a
 * caption — and the backend seeds a placeholder row per slot at dispatch, so rendering every agent
 * fills the grid with identical empty frames that read as a stall. Sessions are capped well below
 * the number of scouts, so most of the rest are waiting on a slot rather than broken; what they are
 * waiting to do is narrated in the log instead.
 */
export function streamingAgents(activity: Activity): AgentState[] {
  return activity.agents.filter((agent) => !agent.queued && agent.liveStreamUrl);
}

/**
 * The browser grid, kept mountable from more than one screen.
 *
 * A scout's session ends when its item resolves, but the backend holds that channel's last frame,
 * so a tile rendered afterwards shows the page the scout finished on. That is why this survives the
 * move to the shortlist: the screen changes, the pictures stay.
 */
export function AgentTiles({ activity }: { activity: Activity }) {
  const live = streamingAgents(activity);
  const waiting = activity.agents.length - live.length;

  if (live.length === 0) {
    return (
      <div className={styles.tilesEmpty}>
        no browser session is streaming yet — {waiting} scouts waiting for a slot
      </div>
    );
  }
  return (
    <div className={styles.tiles}>
      {live.map((agent) => {
        const item = activity.wishlist.find((entry) => entry.id === agent.itemId);
        return item ? <AgentTile key={agent.agentId} agent={agent} item={item} /> : null;
      })}
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
