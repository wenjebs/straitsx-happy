import type { Wallet } from "../lib/Api";
import { formatMinor } from "../state/derive";
import styles from "./WalletScreen.module.css";

interface WalletScreenProps {
  wallet: Wallet | null;
  onTopUp: () => void;
}

export function WalletScreen({ wallet, onTopUp }: WalletScreenProps) {
  if (!wallet) return <div className={styles.screen} />;
  const amount = formatMinor(wallet.balanceMinor).replace("S$", "");

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <h2 className={styles.h2}>Wallet</h2>

        <div className={styles.panels}>
          <div className={styles.panel}>
            <div className={styles.eyebrowTight}>XSGD balance</div>
            <div className={styles.balance}>{amount}</div>
            <div className={styles.balanceMeta}>
              ≈ S${amount} · {wallet.address} · {wallet.network}
            </div>
            <div className={styles.actions}>
              <button type="button" className={styles.primary} onClick={onTopUp}>
                Top up
              </button>
              <button type="button" className={styles.secondary}>
                Withdraw
              </button>
            </div>
            {wallet.receipt && <div className={styles.toast}>{wallet.receipt}</div>}
          </div>

          <div className={styles.panel}>
            <div className={styles.eyebrowTight}>Disposable cards</div>
            <div className={styles.cards}>
              {wallet.cards.map((card) => (
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
          {wallet.transactions.map((txn) => (
            <div className={styles.txn} key={txn.id}>
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
