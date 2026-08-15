import { STAGE_GROUPS } from "../state/derive";
import type { Stage } from "../state/types";
import { Chevrons } from "./Chevrons";
import styles from "./StageBar.module.css";

interface StageBarProps {
  stage: Stage;
  fraction: number;
  onJump: (stage: Stage) => void;
}

/**
 * Five clickable groups of eight chevrons. Clicking one jumps the flow to that
 * stage with seeded data — a demo affordance to review with the product owner
 * before shipping.
 */
export function StageBar({ stage, fraction, onJump }: StageBarProps) {
  return (
    <div className={styles.bar}>
      {STAGE_GROUPS.map((group, gi) => {
        const active = (group.matches as readonly Stage[]).includes(stage);
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
