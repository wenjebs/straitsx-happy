import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, parseUnits, stringToHex } from "viem";
import type { FundingConfiguration, Wallet, WalletDeposit, WalletDepositResult } from "../lib/Api";
import * as Api from "../lib/Api";
import { formatMinor } from "../state/derive";
import styles from "./WalletScreen.module.css";

interface WalletScreenProps {
  wallet: Wallet | null;
  onWalletUpdated: (wallet: Wallet) => void;
}

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export function WalletScreen({ wallet, onWalletUpdated }: WalletScreenProps) {
  const [configuration, setConfiguration] = useState<FundingConfiguration | null>(null);
  const [deposits, setDeposits] = useState<WalletDeposit[]>([]);
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [authorizedAddress, setAuthorizedAddress] = useState<string | null>(
    Api.getWalletSessionAddress(),
  );
  const [amount, setAmount] = useState("50.00");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Api.getWalletFunding()
      .then((snapshot) => {
        if (cancelled) return;
        setConfiguration(snapshot.configuration);
        setDeposits(snapshot.deposits);
      })
      .catch((reason) => {
        if (!cancelled) setError(asMessage(reason));
      });
    const provider = ethereum();
    if (provider) {
      void provider
        .request({ method: "eth_accounts" })
        .then((accounts) => {
          if (!cancelled) setConnectedAddress(firstAccount(accounts));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const pending = deposits.filter((row) => row.status === "pending");
    if (pending.length === 0) return;
    const timer = window.setTimeout(() => {
      void Promise.all(pending.map((row) => Api.refreshWalletDeposit(row.txHash)))
        .then((results) => {
          for (const result of results) {
            applyResult(result, onWalletUpdated, setDeposits, setMessage);
          }
        })
        .catch((reason) => setError(asMessage(reason)));
    }, 4_000);
    return () => window.clearTimeout(timer);
  }, [deposits, onWalletUpdated]);

  if (!wallet) return <div className={styles.screen} />;
  const balance = formatMinor(wallet.balanceMinor).replace("S$", "");

  const connect = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    const provider = ethereum();
    if (!provider) {
      setError("Install or open an EVM wallet such as MetaMask or Core Wallet to continue.");
      setWorking(false);
      return;
    }
    try {
      const address = firstAccount(await provider.request({ method: "eth_requestAccounts" }));
      if (!address) throw new Error("The wallet did not provide an account.");
      setConnectedAddress(address);
      const challenge = await Api.createWalletAuthChallenge(address);
      const signature = await provider.request({
        method: "personal_sign",
        params: [stringToHex(challenge.message), address],
      });
      if (typeof signature !== "string") {
        throw new Error("The wallet did not return an authorization signature.");
      }
      const session = await Api.verifyWalletAuth(challenge.challengeToken, signature);
      setAuthorizedAddress(session.address.toLowerCase());
      const [nextWallet, snapshot] = await Promise.all([Api.getWallet(), Api.getWalletFunding()]);
      onWalletUpdated(nextWallet);
      setConfiguration(snapshot.configuration);
      setDeposits(snapshot.deposits);
      setMessage("Wallet authorized. This signature does not permit spending.");
    } catch (reason) {
      setError(asMessage(reason));
    } finally {
      setWorking(false);
    }
  };

  const deposit = async () => {
    if (!configuration?.enabled) return;
    const provider = ethereum();
    if (!provider || !connectedAddress || authorizedAddress !== connectedAddress.toLowerCase()) {
      await connect();
      return;
    }
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      await ensureChain(provider, configuration);
      const normalizedAmount = amount.trim();
      if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(normalizedAmount)) {
        throw new Error("Enter the XSGD amount using no more than two decimal places.");
      }
      const amountAtomic = parseUnits(normalizedAmount, configuration.tokenDecimals);
      if (amountAtomic <= 0n) throw new Error("Enter an amount greater than S$0.00.");
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [configuration.walletAddress as `0x${string}`, amountAtomic],
      });
      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: connectedAddress,
            to: configuration.tokenAddress,
            data,
            value: "0x0",
          },
        ],
      });
      if (typeof txHash !== "string") {
        throw new Error("The wallet did not return a transaction hash.");
      }
      setMessage("Transfer submitted. Happy is verifying it on-chain.");
      const result = await Api.registerWalletDeposit(txHash, connectedAddress);
      applyResult(result, onWalletUpdated, setDeposits, setMessage);
    } catch (reason) {
      setError(asMessage(reason));
    } finally {
      setWorking(false);
    }
  };

  const refresh = async (txHash: string) => {
    setWorking(true);
    setError(null);
    try {
      const result = await Api.refreshWalletDeposit(txHash);
      applyResult(result, onWalletUpdated, setDeposits, setMessage);
    } catch (reason) {
      setError(asMessage(reason));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <h2 className={styles.h2}>Wallet</h2>

        <div className={styles.panels}>
          <div className={styles.panel}>
            <div className={styles.eyebrowTight}>Your Happy balance</div>
            <div className={styles.balance}>{balance}</div>
            <div className={styles.balanceMeta}>
              ≈ S${balance} · XSGD credited to your Happy account
            </div>
            {wallet.receipt && <div className={styles.toast}>{wallet.receipt}</div>}
          </div>

          <div className={styles.panel}>
            <div className={styles.eyebrowTight}>Fund with XSGD</div>
            {!configuration ? (
              <p className={styles.helper}>Loading funding details…</p>
            ) : !configuration.enabled ? (
              <div className={styles.warning}>{configuration.message}</div>
            ) : (
              <>
                <div className={styles.networkRow}>
                  <span>{configuration.networkName}</span>
                  <span>
                    {configuration.requiredConfirmations} confirmation
                    {configuration.requiredConfirmations === 1 ? "" : "s"} required
                  </span>
                </div>
                <div className={styles.addressBox}>
                  <span>{configuration.walletAddress}</span>
                  <button
                    type="button"
                    className={styles.copy}
                    onClick={() => void navigator.clipboard.writeText(configuration.walletAddress)}
                  >
                    Copy
                  </button>
                </div>
                <p className={styles.helper}>
                  XSGD sent here becomes a custodial Happy balance. Send only XSGD on this exact
                  network. Your wallet also needs a small amount of AVAX for network gas.
                </p>
                <div className={styles.fundingControls}>
                  <label className={styles.amountField}>
                    <span>Amount</span>
                    <span className={styles.amountInputWrap}>
                      <span>S$</span>
                      <input
                        value={amount}
                        inputMode="decimal"
                        onChange={(event) => setAmount(event.target.value)}
                        disabled={working}
                        aria-label="XSGD deposit amount"
                      />
                    </span>
                  </label>
                  {connectedAddress && authorizedAddress === connectedAddress.toLowerCase() ? (
                    <button
                      type="button"
                      className={styles.primary}
                      onClick={() => void deposit()}
                      disabled={working}
                    >
                      {working ? "Verifying…" : "Transfer XSGD"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.primary}
                      onClick={() => void connect()}
                      disabled={working}
                    >
                      {working ? "Authorizing…" : "Authorize wallet"}
                    </button>
                  )}
                </div>
                {connectedAddress && (
                  <div className={styles.connected}>
                    {authorizedAddress === connectedAddress.toLowerCase()
                      ? "Authorized"
                      : "Connected"}{" "}
                    · {shortAddress(connectedAddress)}
                  </div>
                )}
              </>
            )}
            {message && <div className={styles.toast}>{message}</div>}
            {error && <div className={styles.error}>{error}</div>}
          </div>
        </div>

        {deposits.length > 0 && (
          <>
            <div className={styles.eyebrowTight}>Deposit verification</div>
            <div className={styles.deposits}>
              {deposits.map((row) => (
                <div className={styles.depositRow} key={row.id}>
                  <span className={`${styles.statusDot} ${styles[row.status]}`} />
                  <span className={styles.depositMain}>
                    <span>
                      {row.amountMinor === null ? "XSGD transfer" : formatMinor(row.amountMinor)}
                    </span>
                    <span>
                      {shortAddress(row.txHash)} · {row.confirmations}/{row.requiredConfirmations}{" "}
                      confirmations
                    </span>
                    {row.failureReason && (
                      <span className={styles.failure}>{row.failureReason}</span>
                    )}
                  </span>
                  <span className={styles.depositActions}>
                    {row.explorerUrl && (
                      <a href={row.explorerUrl} target="_blank" rel="noreferrer">
                        Explorer
                      </a>
                    )}
                    {row.status === "pending" && (
                      <button
                        type="button"
                        onClick={() => void refresh(row.txHash)}
                        disabled={working}
                      >
                        Refresh
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className={styles.eyebrowTight}>Transactions</div>
        <div className={styles.txns}>
          {wallet.transactions.length === 0 && (
            <div className={styles.empty}>No confirmed transactions yet.</div>
          )}
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

function ethereum(): EthereumProvider | null {
  return (window as typeof window & { ethereum?: EthereumProvider }).ethereum ?? null;
}

function firstAccount(value: unknown): string | null {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

async function ensureChain(
  provider: EthereumProvider,
  configuration: Extract<FundingConfiguration, { enabled: true }>,
) {
  const expected = `0x${configuration.chainId.toString(16)}`;
  const current = await provider.request({ method: "eth_chainId" });
  if (current === expected) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: expected }],
    });
  } catch (reason) {
    if ((reason as { code?: number }).code !== 4902) throw reason;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: expected,
          chainName: configuration.networkName,
          nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
          rpcUrls: [configuration.rpcUrl],
          blockExplorerUrls: [configuration.explorerUrl],
        },
      ],
    });
  }
}

function applyResult(
  result: WalletDepositResult,
  onWalletUpdated: (wallet: Wallet) => void,
  setDeposits: Dispatch<SetStateAction<WalletDeposit[]>>,
  setMessage: Dispatch<SetStateAction<string | null>>,
) {
  onWalletUpdated(result.wallet);
  setDeposits((current) => [
    result.deposit,
    ...current.filter((row) => row.txHash !== result.deposit.txHash),
  ]);
  setMessage(
    result.deposit.status === "confirmed"
      ? `${formatMinor(result.deposit.amountMinor ?? 0)} XSGD credited to your Happy account.`
      : result.deposit.status === "failed"
        ? "The transfer could not be credited. Review the verification result below."
        : "Transfer found. Refresh after the required confirmations arrive.",
  );
}

function shortAddress(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function asMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
