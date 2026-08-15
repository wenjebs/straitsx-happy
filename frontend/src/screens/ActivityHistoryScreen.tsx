import type { Activity, ActivityCheckpoint, Message } from "../lib/Api";
import styles from "./ActivityHistoryScreen.module.css";

interface ActivityHistoryScreenProps {
  activity: Activity;
  checkpoints: ActivityCheckpoint[];
  onClose: () => void;
}

const REASON_LABELS: Record<string, string> = {
  "activity.created": "Request received",
  "wishlist.prepared": "Wishlist prepared",
  "wishlist.item_added": "Wishlist item added",
  "wishlist.item_removed": "Wishlist item removed",
  "wishlist.approved": "Wishlist approved",
  "wishlist.reopened": "Wishlist reopened",
  "clarification.approved": "Option selected",
  "search.dispatched": "Scouts dispatched",
  "search.paused": "Search paused",
  "search.resumed": "Search resumed",
  "search.item_progress": "Search progress",
  "search.agent_updated": "Scout update",
  "shortlist.prepared": "Listings selected",
  "shortlist.rejected": "Listing rejected",
  "purchase.started": "Buy phase started",
  "purchase.step_updated": "Closer update",
  "purchase.log_appended": "Purchase retry update",
  "purchase.completed": "Purchase completed",
  "purchase.cancelled": "Purchase cancelled",
  "activity.cancelled": "Activity cancelled",
};

export function ActivityHistoryScreen({
  activity,
  checkpoints,
  onClose,
}: ActivityHistoryScreenProps) {
  const conversation = collectConversation(checkpoints, activity.messages);
  const latest = checkpoints.at(-1)?.activity ?? activity;

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <button type="button" className={styles.back} onClick={onClose}>
          ← Back to activity summary
        </button>
        <div className="eyebrow">immutable activity history</div>
        <h2 className={styles.title}>{activity.title}</h2>
        <p className={styles.intro}>
          The original chat and every saved transition from planning through the buy phase.
        </p>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h3>Conversation</h3>
            <span>{conversation.length} messages</span>
          </div>
          <div className={styles.chat}>
            {conversation.length > 0 ? (
              conversation.map(({ message, createdAt }) => (
                <article
                  className={`${styles.message} ${message.role === "user" ? styles.user : styles.assistant}`}
                  key={message.id}
                >
                  <div className={styles.messageMeta}>
                    <span>{message.role === "user" ? "You" : "Happy"}</span>
                    <time>{formatTimestamp(createdAt)}</time>
                  </div>
                  <p>{messageText(message)}</p>
                </article>
              ))
            ) : (
              <div className={styles.empty}>No chat messages were retained for this activity.</div>
            )}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h3>Saved journey</h3>
            <span>{checkpoints.length} checkpoints</span>
          </div>
          <div className={styles.timeline}>
            {checkpoints.map((checkpoint, index) => (
              <article className={styles.checkpoint} key={checkpoint.checkpointId}>
                <span className={styles.marker} aria-hidden="true" />
                <div className={styles.checkpointHead}>
                  <strong>{REASON_LABELS[checkpoint.reason] ?? humanize(checkpoint.reason)}</strong>
                  <time>{formatTimestamp(checkpoint.createdAt)}</time>
                </div>
                <div className={styles.tags}>
                  <span>{checkpoint.stage}</span>
                  <span>{checkpoint.status}</span>
                </div>
                <p>{checkpointSummary(checkpoint, checkpoints[index - 1])}</p>
              </article>
            ))}
          </div>
        </section>

        {latest.log.length > 0 && (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3>Buy-phase log</h3>
              <span>{latest.log.length} events</span>
            </div>
            <div className={styles.buyLog}>
              {latest.log.map((line) => (
                <div className={styles.logLine} key={line.id}>
                  <time>{line.ts}</time>
                  <span>{line.tag}</span>
                  <p>{line.text}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function collectConversation(checkpoints: ActivityCheckpoint[], fallback: Message[]) {
  const seen = new Set<string>();
  const messages: { message: Message; createdAt: string }[] = [];
  for (const checkpoint of checkpoints) {
    for (const message of checkpoint.activity.messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push({ message, createdAt: checkpoint.createdAt });
    }
  }
  if (messages.length === 0) {
    return fallback.map((message) => ({ message, createdAt: "" }));
  }
  return messages;
}

function messageText(message: Message): string {
  if (message.text.trim()) return message.text;
  if (message.card === "thinking") return message.thinkingLabel ?? "Thinking";
  return `${message.card ?? "Activity"} card shown`;
}

function checkpointSummary(checkpoint: ActivityCheckpoint, previous?: ActivityCheckpoint): string {
  const current = checkpoint.activity;
  const reason = checkpoint.reason;
  if (reason === "activity.created") return current.messages[0]?.text ?? current.title;
  if (reason.startsWith("wishlist.")) {
    return `${current.wishlist.length} wishlist item${current.wishlist.length === 1 ? "" : "s"}: ${current.wishlist.map((item) => item.name).join(", ") || "none"}.`;
  }
  if (reason === "clarification.approved") {
    const priorIds = new Set(previous?.activity.messages.map((message) => message.id) ?? []);
    const choice = current.messages.findLast(
      (message) => message.role === "user" && !priorIds.has(message.id),
    );
    return choice ? `Selected “${choice.text}”.` : "A product option was locked.";
  }
  if (reason.startsWith("search.")) {
    const selected = current.itemProgress.filter((item) => item.stage === 4).length;
    const latestAgent = current.agents.at(-1);
    return latestAgent
      ? `${latestAgent.action} · ${selected}/${current.wishlist.length} items selected.`
      : `${selected}/${current.wishlist.length} items selected.`;
  }
  if (reason.startsWith("shortlist.")) {
    return current.shortlist.length
      ? current.shortlist.map((pick) => `${pick.listing.title} (${pick.listing.price})`).join(" · ")
      : "Happy returned the selected listing to the Scouts.";
  }
  if (reason.startsWith("purchase.")) {
    return current.log.at(-1)?.text ?? `${current.execution.length} checkout rows recorded.`;
  }
  if (reason.endsWith("cancelled")) return "The user stopped all future work for this activity.";
  return `Saved while the activity was ${checkpoint.status} in ${checkpoint.stage}.`;
}

function humanize(reason: string): string {
  return reason.replaceAll(".", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTimestamp(value: string): string {
  if (!value) return "time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Singapore",
  }).format(date);
}
