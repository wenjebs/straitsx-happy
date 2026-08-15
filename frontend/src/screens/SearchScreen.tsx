import {
  ACTIVITY_TITLE,
  AGENT_HOSTS,
  type Item,
  STAGE_ACTIONS,
  STAGES,
  type StageIndex,
} from "../data/catalog";
import { activeItems, type ItemPosition, itemPosition } from "../state/derive";
import type { HappyState } from "../state/types";
import type { Action } from "../state/useHappy";
import styles from "./SearchScreen.module.css";

interface SearchScreenProps {
  state: HappyState;
  dispatch: React.Dispatch<Action>;
  tickMs: number;
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

/** Position along the track, in percent, for a stage index. */
function stagePercent(stage: number): number {
  return (stage / 4) * 100;
}

/** Nudges the dot left by its own width as it approaches the far end. */
function offsetLeft(pct: number): string {
  return `calc(${pct}% - ${(pct / 100) * 11}px)`;
}

export function SearchScreen({ state, dispatch, tickMs }: SearchScreenProps) {
  const items = activeItems(state);
  const positions = new Map<string, ItemPosition>(
    items.map((i) => [i.id, itemPosition(i, state.tick)]),
  );

  return (
    <div className={styles.screen}>
      <div className={styles.head}>
        <div>
          <div className="eyebrow">Multi-agent search</div>
          <h2 className="screen-title">{ACTIVITY_TITLE}</h2>
        </div>
        <div className={styles.headMeta}>
          <span>
            {items.length} items · {items.length * 2} agents
          </span>
          <span>t+{Math.round(state.tick * (tickMs / 1000))}s</span>
          <span className={styles.run}>
            <span className={styles.runDot} />
            {state.playing ? "live" : "paused"}
          </span>
          <button
            type="button"
            className={styles.playToggle}
            onClick={() => dispatch({ type: "togglePlay" })}
          >
            {state.playing ? "pause" : "resume"}
          </button>
        </div>
      </div>

      <div className={styles.track}>
        <div className={styles.trackScroll}>
          <div className={styles.trackInner}>
            <div className={styles.stops}>
              {STAGES.map((label, i) => (
                <div
                  key={label}
                  className={`${styles.stop} ${
                    i === 0 ? styles.stopFirst : i === STAGES.length - 1 ? styles.stopLast : ""
                  }`}
                >
                  {label}
                </div>
              ))}
            </div>

            <div className={styles.rule}>
              {STAGES.map((label, i) => (
                <span
                  key={label}
                  className={styles.tick}
                  style={{ left: `calc(${(i / 4) * 100}% - ${(i / 4) * 2}px)` }}
                />
              ))}
            </div>

            {items.map((item) => {
              const pos = positions.get(item.id);
              if (!pos) return null;
              const pct = stagePercent(pos.stage);
              /* One string, shared verbatim by the dot and its label. */
              const lane: CSSVars = { "--move": pos.back ? BACKWARD : FORWARD };
              return (
                <div className={styles.lane} key={item.id} style={lane}>
                  <span
                    className={`${styles.dot} ${pos.waiting ? styles.queued : ""}`}
                    style={{
                      left: offsetLeft(pct),
                      /* Queued dots take the class's white fill instead. */
                      ...(pos.waiting ? {} : { background: item.hue }),
                      boxShadow: pos.back
                        ? `0 0 0 5px color-mix(in oklab, ${item.hue} 22%, transparent)`
                        : "none",
                    }}
                  />
                  <span
                    className={`${styles.tag} ${pct > 70 ? styles.tagFlipped : ""} ${
                      pos.waiting ? styles.tagQueued : ""
                    }`}
                    style={{
                      left: offsetLeft(pct),
                      ...(pos.waiting ? {} : { color: item.hue }),
                    }}
                  >
                    {item.short}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className={styles.legend}>
          {items.map((item) => {
            const pos = positions.get(item.id);
            if (!pos) return null;
            return (
              <div className={styles.legendItem} key={item.id}>
                <span className={styles.legendChip} style={{ background: item.hue }} />
                <span className={styles.legendName}>{item.name}</span>
                <span className={styles.legendStage}>
                  {pos.waiting ? "queued" : STAGES[pos.stage].toLowerCase()}
                </span>
                {pos.back && !pos.waiting && <span className={styles.recheck}>re-check ↩</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.tiles}>
        {items.flatMap((item, index) =>
          [0, 1].map((slot) => {
            const pos = positions.get(item.id);
            if (!pos) return null;
            return (
              <AgentTile
                key={`${item.id}-${slot}`}
                item={item}
                index={index}
                slot={slot}
                position={pos}
              />
            );
          }),
        )}
      </div>
    </div>
  );
}

interface AgentTileProps {
  item: Item;
  index: number;
  /** 0 is the lead agent; 1 trails one stage behind, so items spread out. */
  slot: number;
  position: ItemPosition;
}

function AgentTile({ item, index, slot, position }: AgentTileProps) {
  const stage = (slot === 0 ? position.stage : Math.max(0, position.stage - 1)) as StageIndex;
  const agentId = `ag-${(4100 + index * 17 + slot * 3).toString(16)}`;
  const url = `${AGENT_HOSTS[item.id]}${slot ? "?p=2" : ""}`;
  /* Every third tile mocks a result grid; the rest mock a scrolling page. */
  const isGrid = (index + slot) % 3 === 2;

  return (
    <div
      className={`${styles.tile} ${position.waiting ? styles.tileQueued : ""}`}
      style={{ borderColor: item.hue }}
    >
      <div className={styles.viewport}>
        <div className={styles.chrome}>
          <span className={styles.chromeChip} style={{ background: item.hue }} />
          <span className={styles.url}>{url}</span>
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
          <span className={styles.agentId}>{agentId}</span>
          <span className={styles.agentStage}>
            {position.waiting ? "queued" : STAGES[stage].toLowerCase()}
          </span>
        </div>
        <div className={styles.agentAction}>
          {item.name} · {position.waiting ? "waiting for a slot" : STAGE_ACTIONS[stage]}
        </div>
      </div>
    </div>
  );
}
