import type { ActivityStage } from "../lib/Api";
import { STAGE_GROUPS } from "../state/derive";
import { Chevrons } from "./Chevrons";
import styles from "./StageBar.module.css";

interface StageBarProps {
  stage: ActivityStage;
  fraction: number;
  onJump: (stage: ActivityStage) => void;
}

/**
 * Five groups of eight chevrons. Jumping is a demo affordance; it asks the
 * backend to move the activity rather than faking client state, and it never
 * starts a spend.
 */
export function StageBar({ stage, fraction, onJump }: StageBarProps) {
  return (
    <div className={styles.bar}>
      {STAGE_GROUPS.map((group, gi) => {
        const active = (group.matches as readonly ActivityStage[]).includes(stage);
        const local = Math.max(0, Math.min(1, fraction * 5 - gi));
        const labelClass = active ? styles.current : local >= 1 ? styles.reached : "";
        return (
          <button
            type="button"
            key={group.name}
            onClick={() => onJump(group.target)}
            className={`${styles.group} ${active ? styles.active : ""}`}
          >
            <Chevrons fraction={local} count={8} gap={2} />
            <span className={`${styles.label} ${labelClass}`}>{group.name}</span>
          </button>
        );
      })}
    </div>
  );
}
