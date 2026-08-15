import { PROFILE_ROWS } from "../data/catalog";
import styles from "./ProfileScreen.module.css";

export function ProfileScreen() {
  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <div className={styles.head}>
          <span className={styles.avatar}>TL</span>
          <div>
            <div className={styles.name}>Tricia Lim</div>
            <div className={styles.meta}>tricia.lim@hey.sg · member since Mar 2026</div>
          </div>
        </div>

        <div className={styles.panel}>
          {PROFILE_ROWS.map((row) => (
            <div className={styles.row} key={row.k}>
              <span className={styles.key}>{row.k}</span>
              <span className={styles.value}>{row.v}</span>
            </div>
          ))}
        </div>

        <button type="button" className={styles.signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
