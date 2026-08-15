import type {
  Wallet,
  WalletDeposit,
  WalletDepositResult,
  WalletFundingSnapshot,
  WalletTransaction,
} from "../domain.js";
import { formatMinor, newId } from "../domain.js";
import { HttpError } from "../errors.js";
import type { DepositInspection, FundingProvider } from "../providers/funding.js";
import type { Repository } from "../repository.js";

export class WalletFundingService {
  constructor(
    private readonly repository: Repository,
    private readonly provider: FundingProvider,
  ) {}

  async wallet(userId: string): Promise<Wallet> {
    return this.decorateWallet(await this.repository.getWallet(userId));
  }

  async snapshot(userId: string): Promise<WalletFundingSnapshot> {
    return {
      configuration: this.provider.configuration(),
      deposits: await this.repository.listWalletDeposits(userId),
    };
  }

  async submit(
    userId: string,
    txHash: string,
    sourceAddress: string,
  ): Promise<WalletDepositResult> {
    const configuration = this.provider.configuration();
    if (!configuration.enabled) throw new HttpError(503, configuration.message);
    const normalizedHash = normalizeTxHash(txHash);
    const normalizedSource = sourceAddress.toLowerCase();
    const now = new Date().toISOString();
    const created = await this.repository.createWalletDeposit({
      id: newId("deposit"),
      userId,
      txHash: normalizedHash,
      sourceAddress: normalizedSource,
      destinationAddress: configuration.walletAddress.toLowerCase(),
      tokenAddress: configuration.tokenAddress.toLowerCase(),
      chainId: configuration.chainId,
      status: "pending",
      amountAtomic: null,
      amountMinor: null,
      confirmations: 0,
      requiredConfirmations: configuration.requiredConfirmations,
      explorerUrl: `${configuration.explorerUrl}/tx/${normalizedHash}`,
      createdAt: now,
      updatedAt: now,
    });
    if (created.userId !== userId || created.sourceAddress !== normalizedSource) {
      throw new HttpError(409, "This transaction hash has already been registered.");
    }
    return this.refresh(userId, normalizedHash);
  }

  async refresh(userId: string, txHash: string): Promise<WalletDepositResult> {
    const normalizedHash = normalizeTxHash(txHash);
    const deposit = await this.repository.getWalletDeposit(normalizedHash);
    if (!deposit || deposit.userId !== userId) {
      throw new HttpError(404, "Deposit not found.");
    }
    if (deposit.status !== "pending") {
      return { deposit, wallet: await this.wallet(userId) };
    }

    let inspection: DepositInspection;
    try {
      inspection = await this.provider.inspectDeposit(deposit.txHash, deposit.sourceAddress);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        `Could not verify the XSGD transfer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const now = new Date().toISOString();
    if (inspection.status === "pending") {
      const pending = {
        ...deposit,
        confirmations: inspection.confirmations,
        updatedAt: now,
      };
      await this.repository.putWalletDeposit(pending);
      return { deposit: pending, wallet: await this.wallet(userId) };
    }
    if (inspection.status === "failed") {
      const failed: WalletDeposit = {
        ...deposit,
        status: "failed",
        confirmations: inspection.confirmations,
        failureReason: inspection.reason,
        updatedAt: now,
      };
      await this.repository.putWalletDeposit(failed);
      return { deposit: failed, wallet: await this.wallet(userId) };
    }

    const confirmed: WalletDeposit = {
      ...deposit,
      status: "confirmed",
      amountAtomic: inspection.amountAtomic.toString(),
      amountMinor: inspection.amountMinor,
      confirmations: inspection.confirmations,
      blockNumber: inspection.blockNumber.toString(),
      updatedAt: now,
      confirmedAt: now,
    };
    const transaction: WalletTransaction = {
      id: newId("txn"),
      ts: transactionTime(new Date()),
      label: "XSGD deposit",
      ref: shortHash(deposit.txHash),
      amount: `+${formatMinor(inspection.amountMinor)}`,
      debit: false,
    };
    const result = await this.repository.confirmWalletDeposit(
      confirmed,
      transaction,
      `+${formatMinor(inspection.amountMinor).replace("S$", "")} XSGD received · tx ${shortHash(deposit.txHash)} · ${inspection.confirmations} confirmation${inspection.confirmations === 1 ? "" : "s"}`,
    );
    return { deposit: result.deposit, wallet: this.decorateWallet(result.wallet) };
  }

  private decorateWallet(wallet: Wallet): Wallet {
    const configuration = this.provider.configuration();
    if (!configuration.enabled) return wallet;
    return {
      ...wallet,
      address: configuration.walletAddress,
      network: configuration.networkName,
    };
  }
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function normalizeTxHash(hash: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new HttpError(400, "Transaction hash must be a 32-byte hexadecimal value.");
  }
  return hash.toLowerCase();
}

function transactionTime(date: Date): string {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
