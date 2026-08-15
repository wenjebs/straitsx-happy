import { Chevrons } from "../components/Chevrons";
import type { ArchivedActivity } from "../data/catalog";
import styles from "./ArchiveScreen.module.css";

interface ArchiveScreenProps {
  archive: ArchivedActivity;
}

/** A focused past activity: summary bar over its line items. */
export function ArchiveScreen({ archive }: ArchiveScreenProps) {
  const cancelled = archive.state === "cancelled";

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <div className="eyebrow">{archive.state} activity</div>
        <h2 className={styles.title}>{archive.title}</h2>

        <div className={styles.summary}>
          <Chevrons
            fraction={archive.frac}
            count={40}
            gap={2}
            wrap
            {...(cancelled ? { mode: "cancelled" as const } : {})}
          />
          <div className={styles.summaryMeta}>
            <span>{cancelled ? "cancelled at shortlist" : "all items purchased"}</span>
            <span className={styles.total}>{archive.total}</span>
          </div>
        </div>

        <div className={styles.list}>
          {archive.lines.map((line) => (
            <div className={styles.row} key={line.name}>
              <div className={styles.lineBody}>
                <div className={styles.name}>{line.name}</div>
                <div className={styles.seller}>{line.seller}</div>
              </div>
              <span className={styles.price}>{line.price}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
