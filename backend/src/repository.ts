import type {
  Activity,
  ActivityCheckpoint,
  Mandate,
  Profile,
  PurchaseRun,
  Settings,
  Wallet,
} from "./domain.js";

export interface PurchaseClaim {
  claimed: boolean;
  key: string;
}

export interface Repository {
  listActivities(userId: string): Promise<Activity[]>;
  getActivity(id: string): Promise<Activity | null>;
  putActivity(activity: Activity, reason?: string): Promise<void>;
  listActivityCheckpoints(activityId: string): Promise<ActivityCheckpoint[]>;

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
  getPurchaseRun(activityId: string): Promise<PurchaseRun | null>;
  putPurchaseRun(run: PurchaseRun): Promise<void>;
}
