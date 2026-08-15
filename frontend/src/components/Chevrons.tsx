import { chevronColors } from "../state/derive";
import styles from "./Chevrons.module.css";

/**
 * The core progress primitive, used at three sizes: 8 per group in the stage
 * bar, 26 in an activity feed card, 40 in an archive summary. Given a fraction
 * and a count, the filled chevrons take the warm ramp colour for their index.
 */
interface ChevronsProps {
  fraction: number;
  count: number;
  /** 2px in the stage bar and archive, 1.5px in the narrower feed card. */
  gap: number;
  mode?: "cancelled";
  wrap?: boolean;
  clip?: boolean;
}

export function Chevrons({ fraction, count, gap, mode, wrap, clip }: ChevronsProps) {
  const colors = chevronColors(fraction, count, mode);
  const className = [styles.bar, wrap && styles.wrap, clip && styles.clip]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={className} style={{ gap: `${gap}px` }} aria-hidden="true">
      {colors.map((color, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative bar
        <span key={i} className={styles.chevron} style={{ background: color }} />
      ))}
    </span>
  );
}
