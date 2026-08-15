import { defaultMandate, defaultProfile, defaultSettings, defaultWallet } from "../defaults.js";
import type { Activity, Mandate, Profile, Settings, Wallet } from "../domain.js";
import type { PurchaseClaim, Repository } from "../repository.js";

export class MemoryRepository implements Repository {
  private readonly activities = new Map<string, Activity>();
  private readonly wallets = new Map<string, Wallet>();
  private readonly mandates = new Map<string, Mandate>();
  private readonly settings = new Map<string, Settings>();
  private readonly profiles = new Map<string, Profile>();
  private readonly purchaseClaims = new Map<string, string>();

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

  async putActivity(activity: Activity): Promise<void> {
    this.activities.set(activity.id, structuredClone(activity));
  }

  async getWallet(userId: string): Promise<Wallet> {
    const wallet = this.wallets.get(userId) ?? defaultWallet();
    this.wallets.set(userId, structuredClone(wallet));
    return structuredClone(wallet);
  }

  async putWallet(userId: string, wallet: Wallet): Promise<void> {
    this.wallets.set(userId, structuredClone(wallet));
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
}
