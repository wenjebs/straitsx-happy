import type { Profile } from "../lib/Api";
import styles from "./ProfileScreen.module.css";

interface ProfileScreenProps {
  profile: Profile | null;
  onSignOut: () => void;
}

export function ProfileScreen({ profile, onSignOut }: ProfileScreenProps) {
  if (!profile) return <div className={styles.screen} />;

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <div className={styles.head}>
          <span className={styles.avatar}>{profile.initials}</span>
          <div>
            <div className={styles.name}>{profile.name}</div>
            <div className={styles.meta}>{profile.memberSince}</div>
          </div>
        </div>

        <div className={styles.panel}>
          {profile.rows.map((row) => (
            <div className={styles.row} key={row.k}>
              <span className={styles.key}>{row.k}</span>
              <span className={styles.value}>{row.v}</span>
            </div>
          ))}
        </div>

        <button type="button" className={styles.signOut} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
