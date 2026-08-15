import { ArrowUpIcon } from "../components/Icons";
import { SUGGESTIONS } from "../data/catalog";
import type { HappyState, Message } from "../state/types";
import type { Action } from "../state/useHappy";
import styles from "./ChatScreen.module.css";
import { CuratorCard } from "./chat/CuratorCard";
import { LockedPanel } from "./chat/LockedPanel";
import { WishlistCard } from "./chat/WishlistCard";

interface ChatScreenProps {
  state: HappyState;
  dispatch: React.Dispatch<Action>;
}

export function ChatScreen({ state, dispatch }: ChatScreenProps) {
  return (
    <>
      <div className={styles.scroll}>
        <div className={styles.column}>
          {state.msgs.length === 0 && (
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
                    onClick={() => dispatch({ type: "setDraft", value: text })}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {state.msgs.map((message, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript
            <div className={styles.message} key={i}>
              <MessageBody message={message} state={state} dispatch={dispatch} />
            </div>
          ))}
        </div>
      </div>

      <div className={styles.composerWrap}>
        <div className={styles.composer}>
          <input
            className={styles.input}
            value={state.draft}
            onChange={(e) => dispatch({ type: "setDraft", value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") dispatch({ type: "send" });
            }}
            placeholder={
              "Give me a list, or tell me a goal — “build me a budget gaming PC under S$1,600”"
            }
            aria-label="Message Happy"
          />
          <button
            type="button"
            className={styles.send}
            onClick={() => dispatch({ type: "send" })}
            aria-label="Send"
          >
            <ArrowUpIcon />
          </button>
        </div>
        <div className={styles.note}>
          Mandate active · auto-approve under S$600/item · card issued per purchase
        </div>
      </div>
    </>
  );
}

function MessageBody({
  message,
  state,
  dispatch,
}: {
  message: Message;
  state: HappyState;
  dispatch: React.Dispatch<Action>;
}) {
  if (message.kind === "user") {
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

        {message.kind === "thinking" && (
          <div className={styles.thinking}>
            <span className={styles.thinkingDot} />
            <span>{message.label}</span>
          </div>
        )}

        {message.kind === "wishlist" && <WishlistCard state={state} dispatch={dispatch} />}

        {message.kind === "curator" && (
          <CuratorCard itemId={message.itemId} state={state} dispatch={dispatch} />
        )}

        {message.kind === "locked" && <LockedPanel state={state} dispatch={dispatch} />}
      </div>
    </div>
  );
}
