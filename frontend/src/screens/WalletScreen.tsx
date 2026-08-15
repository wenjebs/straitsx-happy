import { DISPOSABLE_CARDS, money, TRANSACTIONS } from "../data/catalog";
import type { HappyState } from "../state/types";
import type { Action } from "../state/useHappy";
import styles from "./WalletScreen.module.css";

interface WalletScreenProps {
  state: HappyState;
  dispatch: React.Dispatch<Action>;
}

export function WalletScreen({ state, dispatch }: WalletScreenProps) {
  const amount = money(state.balance).replace("S$", "");

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <h2 className={styles.h2}>Wallet</h2>

        <div className={styles.panels}>
          <div className={styles.panel}>
            <div className={styles.eyebrowTight}>XSGD balance</div>
            <div className={styles.balance}>{amount}</div>
            <div className={styles.balanceMeta}>≈ S${amount} · 0x8f…c14b · Polygon</div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                onClick={() => dispatch({ type: "topUp" })}
              >
                Top up
              </button>
              <button type="button" className={styles.secondary}>
                Withdraw
              </button>
            </div>
            {state.toast && <div className={styles.toast}>{state.toast}</div>}
          </div>

          <div className={styles.panel}>
            <div className={styles.eyebrowTight}>Disposable cards</div>
            <div className={styles.cards}>
              {DISPOSABLE_CARDS.map((card) => (
                <div className={styles.cardRow} key={card.pan}>
                  <span className={styles.pan}>{card.pan}</span>
                  <span className={styles.cardAmount}>{card.amount}</span>
                  <span
                    className={`${styles.chip} ${
                      card.status === "used"
                        ? styles.chipUsed
                        : card.status === "expired"
                          ? styles.chipExpired
                          : ""
                    }`}
                  >
                    {card.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.eyebrowTight}>Transactions</div>
        <div className={styles.txns}>
          {TRANSACTIONS.map((txn) => (
            <div className={styles.txn} key={`${txn.ts}-${txn.ref}`}>
              <span className={styles.txnTs}>{txn.ts}</span>
              <span className={styles.txnLabel}>{txn.label}</span>
              <span className={styles.txnRef}>{txn.ref}</span>
              <span className={`${styles.txnAmount} ${txn.debit ? styles.debit : ""}`}>
                {txn.amount}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
