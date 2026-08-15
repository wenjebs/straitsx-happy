import { Toggle } from "../components/Toggle";
import type { Mandate } from "../lib/Api";
import styles from "./MandateScreen.module.css";

interface MandateScreenProps {
  mandate: Mandate | null;
  onChange: (changes: Partial<Mandate>) => void;
}

const CYCLE = ["allowed", "ask first", "blocked"] as const;

/** What agents may spend without asking. The caps feed the wishlist and shortlist. */
export function MandateScreen({ mandate, onChange }: MandateScreenProps) {
  if (!mandate) return <div className={styles.screen} />;

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
              checked={mandate.autoApprove}
              onChange={() => onChange({ autoApprove: !mandate.autoApprove })}
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
              value={mandate.itemCap}
              onChange={(e) => onChange({ itemCap: Number(e.target.value) })}
              className={styles.slider}
              aria-label="Per-item cap"
            />
            <span className={styles.value}>S${mandate.itemCap}</span>
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
              value={mandate.actCap}
              onChange={(e) => onChange({ actCap: Number(e.target.value) })}
              className={styles.slider}
              aria-label="Per-activity cap"
            />
            <span className={styles.value}>S${mandate.actCap}</span>
          </div>

          <div className={styles.rules}>
            <div className={styles.rulesTitle}>Category rules</div>
            <div className={styles.rulesDesc}>
              Optional. Tap to switch a category between allowed, ask first, and blocked.
            </div>
            <div className={styles.chips}>
              {Object.entries(mandate.categoryRules).map(([name, rule]) => (
                <button
                  type="button"
                  key={name}
                  onClick={() =>
                    onChange({
                      categoryRules: {
                        ...mandate.categoryRules,
                        [name]: CYCLE[(CYCLE.indexOf(rule) + 1) % CYCLE.length] ?? "allowed",
                      },
                    })
                  }
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
