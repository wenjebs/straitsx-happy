import { ArrowUpIcon } from "../components/Icons";
import { SUGGESTIONS } from "../data/catalog";
import type { Activity, Message } from "../lib/Api";
import type { HappyState } from "../state/types";
import type { HappyActions } from "../state/useHappy";
import styles from "./ChatScreen.module.css";
import { CuratorCard } from "./chat/CuratorCard";
import { LockedPanel } from "./chat/LockedPanel";
import { WishlistCard } from "./chat/WishlistCard";

interface ChatScreenProps {
  state: HappyState;
  actions: HappyActions;
  activity: Activity | null;
}

export function ChatScreen({ state, actions, activity }: ChatScreenProps) {
  const messages = activity?.messages ?? [];

  return (
    <>
      <div className={styles.scroll}>
        <div className={styles.column}>
          {messages.length === 0 && (
            <div className={styles.empty}>
              <h1>What should we buy today?</h1>
              <p>
                Hand over a list, or describe the outcome you want. Agents research, compare and
                check out with a single-use card.
              </p>
              <div className={styles.pills}>
                {SUGGESTIONS.map((text) => (
                  <button
                    type="button"
                    key={text}
                    className={styles.pill}
                    onClick={() => actions.setDraft(text)}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <div className={styles.message} key={message.id}>
              <MessageBody message={message} state={state} actions={actions} activity={activity} />
            </div>
          ))}
        </div>
      </div>

      <div className={styles.composerWrap}>
        <div className={styles.composer}>
          <input
            className={styles.input}
            value={state.draft}
            onChange={(e) => actions.setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void actions.send();
            }}
            placeholder={
              "Give me a list, or tell me a goal — “build me a budget gaming PC under S$1,600”"
            }
            aria-label="Message Happy"
          />
          <button
            type="button"
            className={styles.send}
            onClick={() => void actions.send()}
            aria-label="Send"
          >
            <ArrowUpIcon />
          </button>
        </div>
        <div className={styles.note}>
          Mandate active · auto-approve under S${state.mandate?.itemCap ?? 600}/item · card issued
          per purchase
        </div>
      </div>
    </>
  );
}

function MessageBody({
  message,
  state,
  actions,
  activity,
}: {
  message: Message;
  state: HappyState;
  actions: HappyActions;
  activity: Activity | null;
}) {
  if (message.role === "user") {
    return (
      <div className={styles.userRow}>
        <div className={styles.bubble}>{message.text}</div>
      </div>
    );
  }

  return (
    <div className={styles.botRow}>
      <span className={styles.avatar} />
      <div className={styles.botBody}>
        <div className={styles.botText}>{message.text}</div>

        {message.card === "thinking" && (
          <div className={styles.thinking}>
            <span className={styles.thinkingDots} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>{message.thinkingLabel}</span>
          </div>
        )}

        {message.card === "wishlist" && activity && (
          <WishlistCard activity={activity} state={state} actions={actions} />
        )}

        {message.card === "curator" && message.itemId && activity && (
          <CuratorCard itemId={message.itemId} activity={activity} actions={actions} />
        )}

        {message.card === "locked" && activity && (
          <LockedPanel activity={activity} actions={actions} />
        )}
      </div>
    </div>
  );
}
