import type { Settings } from "../lib/Api";
import styles from "./SettingsScreen.module.css";

interface SettingsScreenProps {
  settings: Settings | null;
}

export function SettingsScreen({ settings }: SettingsScreenProps) {
  if (!settings) return <div className={styles.screen} />;

  const values = [
    {
      name: "Region & currency",
      desc: "Used for listings, taxes and shipping estimates.",
      value: settings.region,
    },
    {
      name: "Data retention",
      desc: "How long agent transcripts and screenshots are kept.",
      value: settings.dataRetention,
    },
  ];

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <h2 className={styles.h2}>Settings</h2>
        <div className={styles.panel}>
          {values.map((row) => (
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
