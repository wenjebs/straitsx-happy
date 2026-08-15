import { Toggle } from "../components/Toggle";
import type { HappyState } from "../state/types";
import type { Action } from "../state/useHappy";
import styles from "./SettingsScreen.module.css";

interface SettingsScreenProps {
  state: HappyState;
  dispatch: React.Dispatch<Action>;
}

const TOGGLES = [
  {
    key: "notify",
    name: "Push notifications",
    desc: "Alert me when an agent pauses for approval.",
  },
  {
    key: "sandbox",
    name: "Sandbox mode",
    desc: "Run agents end-to-end without issuing real cards.",
  },
] as const;

const VALUES = [
  {
    name: "Region & currency",
    desc: "Used for listings, taxes and shipping estimates.",
    value: "Singapore · SGD",
  },
  {
    name: "Data retention",
    desc: "How long agent transcripts and screenshots are kept.",
    value: "90 days",
  },
] as const;

export function SettingsScreen({ state, dispatch }: SettingsScreenProps) {
  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <h2 className={styles.h2}>Settings</h2>
        <div className={styles.panel}>
          {TOGGLES.map((row) => (
            <div className={styles.row} key={row.key}>
              <div className={styles.rowBody}>
                <div className={styles.name}>{row.name}</div>
                <div className={styles.desc}>{row.desc}</div>
              </div>
              <Toggle
                checked={state.settingsState[row.key]}
                onChange={() => dispatch({ type: "toggleSetting", key: row.key })}
                label={row.name}
              />
            </div>
          ))}
          {VALUES.map((row) => (
            <div className={styles.row} key={row.name}>
              <div className={styles.rowBody}>
                <div className={styles.name}>{row.name}</div>
                <div className={styles.desc}>{row.desc}</div>
              </div>
              <span className={styles.value}>{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
