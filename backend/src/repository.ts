import type { Activity, Mandate, Profile, Settings, Wallet } from "./domain.js";

export interface PurchaseClaim {
  claimed: boolean;
  key: string;
}

export interface Repository {
  listActivities(userId: string): Promise<Activity[]>;
  getActivity(id: string): Promise<Activity | null>;
  putActivity(activity: Activity): Promise<void>;

  getWallet(userId: string): Promise<Wallet>;
  putWallet(userId: string, wallet: Wallet): Promise<void>;
  getMandate(userId: string): Promise<Mandate>;
  putMandate(userId: string, mandate: Mandate): Promise<void>;
  getSettings(userId: string): Promise<Settings>;
  putSettings(userId: string, settings: Settings): Promise<void>;
  getProfile(userId: string): Promise<Profile>;

  /** One immutable purchase lock per activity, also serving idempotency. */
  getPurchaseClaim(activityId: string): Promise<PurchaseClaim | null>;
  claimPurchase(activityId: string, idempotencyKey: string): Promise<PurchaseClaim>;
}
