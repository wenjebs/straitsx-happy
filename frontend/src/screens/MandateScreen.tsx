import { Toggle } from "../components/Toggle";
import type { HappyState } from "../state/types";
import type { Action } from "../state/useHappy";
import styles from "./MandateScreen.module.css";

interface MandateScreenProps {
  state: HappyState;
  dispatch: React.Dispatch<Action>;
}

/** What agents may spend without asking. The caps feed the wishlist and shortlist. */
export function MandateScreen({ state, dispatch }: MandateScreenProps) {
  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <h2 className={styles.h2}>Mandate</h2>
        <p className={styles.lede}>
          What agents may spend without asking. Anything outside these rules pauses for your
          approval.
        </p>

        <div className={styles.panel}>
          <div className={styles.row}>
            <div className={styles.rowBody}>
              <div className={styles.name}>Auto-approve purchases</div>
              <div className={styles.desc}>
                Agents check out without a final tap when every rule below passes.
              </div>
            </div>
            <Toggle
              checked={state.autoApprove}
              onChange={() => dispatch({ type: "toggleAuto" })}
              label="Auto-approve purchases"
            />
          </div>

          <div className={styles.row}>
            <div className={styles.rowBody}>
              <div className={styles.name}>Per-item cap</div>
              <div className={styles.desc}>Highest single line item an agent may buy.</div>
            </div>
            <input
              type="range"
              min={100}
              max={1500}
              step={50}
              value={state.itemCap}
              onChange={(e) => dispatch({ type: "setItemCap", value: Number(e.target.value) })}
              className={styles.slider}
              aria-label="Per-item cap"
            />
            <span className={styles.value}>S${state.itemCap}</span>
          </div>

          <div className={styles.row}>
            <div className={styles.rowBody}>
              <div className={styles.name}>Per-activity cap</div>
              <div className={styles.desc}>Total across all items in one activity.</div>
            </div>
            <input
              type="range"
              min={500}
              max={6000}
              step={100}
              value={state.actCap}
              onChange={(e) => dispatch({ type: "setActCap", value: Number(e.target.value) })}
              className={styles.slider}
              aria-label="Per-activity cap"
            />
            <span className={styles.value}>S${state.actCap}</span>
          </div>

          <div className={styles.rules}>
            <div className={styles.rulesTitle}>Category rules</div>
            <div className={styles.rulesDesc}>
              Optional. Tap to switch a category between allowed, ask first, and blocked.
            </div>
            <div className={styles.chips}>
              {Object.entries(state.ruleState).map(([name, rule]) => (
                <button
                  type="button"
                  key={name}
                  onClick={() => dispatch({ type: "cycleRule", name })}
                  className={`${styles.chip} ${
                    rule === "allowed" ? styles.allowed : rule === "blocked" ? styles.blocked : ""
                  }`}
                >
                  {name} <span className={styles.chipState}>{rule}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
