import { useEffect, useState } from "react";
import { Toggle } from "../components/Toggle";
import type { Mandate } from "../lib/Api";
import styles from "./MandateScreen.module.css";

interface MandateScreenProps {
  mandate: Mandate | null;
  onChange: (changes: Partial<Mandate>) => void;
}

interface MoneyInputProps {
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit: (value: number) => void;
}

function MoneyInput({ value, min, max, label, onCommit }: MoneyInputProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const amount = Number(draft);
    if (!Number.isInteger(amount) || amount < min || amount > max) {
      setDraft(String(value));
      return;
    }
    if (amount !== value) onCommit(amount);
  };

  return (
    <label className={styles.amountControl}>
      <span className={styles.currency}>S$</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(String(value));
          }
        }}
        className={styles.amountInput}
        aria-label={label}
      />
    </label>
  );
}

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
              <div className={styles.desc}>Highest single item an agent may buy, in SGD.</div>
            </div>
            <MoneyInput
              value={mandate.itemCap}
              min={1}
              max={mandate.actCap}
              label="Per-item cap in SGD"
              onCommit={(itemCap) => onChange({ itemCap })}
            />
          </div>

          <div className={styles.row}>
            <div className={styles.rowBody}>
              <div className={styles.name}>Per-activity cap</div>
              <div className={styles.desc}>Total allowed across one activity, in SGD.</div>
            </div>
            <MoneyInput
              value={mandate.actCap}
              min={mandate.itemCap}
              max={1_000_000}
              label="Per-activity cap in SGD"
              onCommit={(actCap) => onChange({ actCap })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
