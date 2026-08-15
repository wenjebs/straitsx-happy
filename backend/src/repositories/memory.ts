import {
  defaultFundingWallet,
  defaultMandate,
  defaultProfile,
  defaultSettings,
  defaultWallet,
} from "../defaults.js";
import type {
  Activity,
  ActivityCheckpoint,
  Mandate,
  Profile,
  PurchaseRun,
  Settings,
  Wallet,
  WalletDeposit,
  WalletTransaction,
} from "../domain.js";
import { DEFAULT_USER_ID } from "../domain.js";
import type { PurchaseClaim, Repository } from "../repository.js";

export class MemoryRepository implements Repository {
  private readonly activities = new Map<string, Activity>();
  private readonly activityCheckpoints = new Map<string, ActivityCheckpoint[]>();
  private readonly wallets = new Map<string, Wallet>();
  private readonly walletDeposits = new Map<string, WalletDeposit>();
  private readonly mandates = new Map<string, Mandate>();
  private readonly settings = new Map<string, Settings>();
  private readonly profiles = new Map<string, Profile>();
  private readonly purchaseClaims = new Map<string, string>();
  private readonly purchaseRuns = new Map<string, PurchaseRun>();

  async listActivities(userId: string): Promise<Activity[]> {
    return [...this.activities.values()]
      .filter((activity) => activity.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((activity) => structuredClone(activity));
  }

  async getActivity(id: string): Promise<Activity | null> {
    const activity = this.activities.get(id);
    return activity ? structuredClone(activity) : null;
  }

  async putActivity(activity: Activity, reason = "activity.updated"): Promise<void> {
    this.activities.set(activity.id, structuredClone(activity));
    const checkpoints = this.activityCheckpoints.get(activity.id) ?? [];
    checkpoints.push({
      checkpointId: crypto.randomUUID(),
      activityId: activity.id,
      userId: activity.userId,
      reason,
      createdAt: new Date().toISOString(),
      stage: activity.stage,
      status: activity.status,
      activity: structuredClone(activity),
    });
    this.activityCheckpoints.set(activity.id, checkpoints);
  }

  async listActivityCheckpoints(activityId: string): Promise<ActivityCheckpoint[]> {
    return structuredClone(this.activityCheckpoints.get(activityId) ?? []);
  }

  async getWallet(userId: string): Promise<Wallet> {
    const wallet =
      this.wallets.get(userId) ??
      (userId === DEFAULT_USER_ID ? defaultWallet() : defaultFundingWallet());
    this.wallets.set(userId, structuredClone(wallet));
    return structuredClone(wallet);
  }

  async putWallet(userId: string, wallet: Wallet): Promise<void> {
    this.wallets.set(userId, structuredClone(wallet));
  }

  async listWalletDeposits(userId: string): Promise<WalletDeposit[]> {
    return [...this.walletDeposits.values()]
      .filter((deposit) => deposit.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((deposit) => structuredClone(deposit));
  }

  async getWalletDeposit(txHash: string): Promise<WalletDeposit | null> {
    const deposit = this.walletDeposits.get(txHash.toLowerCase());
    return deposit ? structuredClone(deposit) : null;
  }

  async createWalletDeposit(deposit: WalletDeposit): Promise<WalletDeposit> {
    const key = deposit.txHash.toLowerCase();
    const existing = this.walletDeposits.get(key);
    if (existing) return structuredClone(existing);
    this.walletDeposits.set(key, structuredClone(deposit));
    return structuredClone(deposit);
  }

  async putWalletDeposit(deposit: WalletDeposit): Promise<void> {
    this.walletDeposits.set(deposit.txHash.toLowerCase(), structuredClone(deposit));
  }

  async confirmWalletDeposit(
    deposit: WalletDeposit,
    transaction: WalletTransaction,
    receipt: string,
  ): Promise<{ deposit: WalletDeposit; wallet: Wallet }> {
    const key = deposit.txHash.toLowerCase();
    const existing = this.walletDeposits.get(key);
    if (existing?.status === "confirmed") {
      return { deposit: structuredClone(existing), wallet: await this.getWallet(existing.userId) };
    }
    if (existing?.status !== "pending" || deposit.amountMinor === null) {
      throw new Error("Deposit is not eligible to be credited.");
    }
    const wallet = await this.getWallet(deposit.userId);
    wallet.balanceMinor += deposit.amountMinor;
    wallet.receipt = receipt;
    wallet.transactions.unshift(structuredClone(transaction));
    this.wallets.set(deposit.userId, structuredClone(wallet));
    this.walletDeposits.set(key, structuredClone(deposit));
    return { deposit: structuredClone(deposit), wallet: structuredClone(wallet) };
  }

  async getMandate(userId: string): Promise<Mandate> {
    const mandate = this.mandates.get(userId) ?? defaultMandate();
    this.mandates.set(userId, structuredClone(mandate));
    return structuredClone(mandate);
  }

  async putMandate(userId: string, mandate: Mandate): Promise<void> {
    this.mandates.set(userId, structuredClone(mandate));
  }

  async getSettings(userId: string): Promise<Settings> {
    const settings = this.settings.get(userId) ?? defaultSettings();
    this.settings.set(userId, structuredClone(settings));
    return structuredClone(settings);
  }

  async putSettings(userId: string, settings: Settings): Promise<void> {
    this.settings.set(userId, structuredClone(settings));
  }

  async getProfile(userId: string): Promise<Profile> {
    const profile = this.profiles.get(userId) ?? defaultProfile();
    this.profiles.set(userId, structuredClone(profile));
    return structuredClone(profile);
  }

  async claimPurchase(activityId: string, idempotencyKey: string): Promise<PurchaseClaim> {
    const existing = this.purchaseClaims.get(activityId);
    if (existing) return { claimed: false, key: existing };
    this.purchaseClaims.set(activityId, idempotencyKey);
    return { claimed: true, key: idempotencyKey };
  }

  async getPurchaseClaim(activityId: string): Promise<PurchaseClaim | null> {
    const key = this.purchaseClaims.get(activityId);
    return key ? { claimed: false, key } : null;
  }

  async getPurchaseRun(activityId: string): Promise<PurchaseRun | null> {
    const run = this.purchaseRuns.get(activityId);
    return run ? structuredClone(run) : null;
  }

  async putPurchaseRun(run: PurchaseRun): Promise<void> {
    this.purchaseRuns.set(run.activityId, structuredClone(run));
  }
}
