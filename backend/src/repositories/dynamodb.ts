import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
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

interface Stored<T> {
  pk: string;
  sk: string;
  entity: string;
  data: T;
  gsi1pk?: string;
  gsi1sk?: string;
}

export interface DynamoRepositoryOptions {
  tableName: string;
  region: string;
  endpoint?: string;
}

export class DynamoRepository implements Repository {
  private readonly document: DynamoDBDocumentClient;

  constructor(
    private readonly options: DynamoRepositoryOptions,
    client?: DynamoDBClient,
  ) {
    const config: DynamoDBClientConfig = {
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    };
    this.document = DynamoDBDocumentClient.from(client ?? new DynamoDBClient(config), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async listActivities(userId: string): Promise<Activity[]> {
    const result = await this.document.send(
      new QueryCommand({
        TableName: this.options.tableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        FilterExpression: "#entity = :entity",
        ExpressionAttributeNames: { "#entity": "entity" },
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":entity": "activity",
        },
        ScanIndexForward: false,
      }),
    );
    return (result.Items ?? []).map((item) => (item as Stored<Activity>).data);
  }

  async getActivity(id: string): Promise<Activity | null> {
    const item = await this.get<Stored<Activity>>(`ACTIVITY#${id}`, "META");
    return item?.data ?? null;
  }

  async putActivity(activity: Activity, reason = "activity.updated"): Promise<void> {
    const checkpoint: ActivityCheckpoint = {
      checkpointId: crypto.randomUUID(),
      activityId: activity.id,
      userId: activity.userId,
      reason,
      createdAt: new Date().toISOString(),
      stage: activity.stage,
      status: activity.status,
      activity,
    };
    const current: Stored<Activity> = {
      pk: `ACTIVITY#${activity.id}`,
      sk: "META",
      entity: "activity",
      data: activity,
      gsi1pk: `USER#${activity.userId}`,
      gsi1sk: `${activity.createdAt}#${activity.id}`,
    };
    const history: Stored<ActivityCheckpoint> = {
      pk: `ACTIVITY#${activity.id}`,
      sk: `CHECKPOINT#${checkpoint.createdAt}#${checkpoint.checkpointId}`,
      entity: "activity-checkpoint",
      data: checkpoint,
    };
    await this.document.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.options.tableName, Item: current } },
          { Put: { TableName: this.options.tableName, Item: history } },
        ],
      }),
    );
  }

  async listActivityCheckpoints(activityId: string): Promise<ActivityCheckpoint[]> {
    const result = await this.document.send(
      new QueryCommand({
        TableName: this.options.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `ACTIVITY#${activityId}`,
          ":prefix": "CHECKPOINT#",
        },
        ScanIndexForward: true,
        ConsistentRead: true,
      }),
    );
    return (result.Items ?? []).map((item) => (item as Stored<ActivityCheckpoint>).data);
  }

  async getWallet(userId: string): Promise<Wallet> {
    return this.getState(
      userId,
      "WALLET",
      userId === DEFAULT_USER_ID ? defaultWallet : defaultFundingWallet,
    );
  }

  async putWallet(userId: string, wallet: Wallet): Promise<void> {
    await this.putState(userId, "WALLET", wallet);
  }

  async listWalletDeposits(userId: string): Promise<WalletDeposit[]> {
    const result = await this.document.send(
      new QueryCommand({
        TableName: this.options.tableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        FilterExpression: "#entity = :entity",
        ExpressionAttributeNames: { "#entity": "entity" },
        ExpressionAttributeValues: {
          ":pk": `USER#${userId}`,
          ":entity": "wallet-deposit",
        },
        ScanIndexForward: false,
        ConsistentRead: false,
      }),
    );
    return (result.Items ?? []).map((item) => (item as Stored<WalletDeposit>).data);
  }

  async getWalletDeposit(txHash: string): Promise<WalletDeposit | null> {
    const stored = await this.get<Stored<WalletDeposit>>(`DEPOSIT#${txHash.toLowerCase()}`, "META");
    return stored?.data ?? null;
  }

  async createWalletDeposit(deposit: WalletDeposit): Promise<WalletDeposit> {
    const item = this.depositItem(deposit);
    try {
      await this.document.send(
        new PutCommand({
          TableName: this.options.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return deposit;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      return (await this.getWalletDeposit(deposit.txHash)) ?? deposit;
    }
  }

  async putWalletDeposit(deposit: WalletDeposit): Promise<void> {
    await this.put(this.depositItem(deposit));
  }

  async confirmWalletDeposit(
    deposit: WalletDeposit,
    transaction: WalletTransaction,
    receipt: string,
  ): Promise<{ deposit: WalletDeposit; wallet: Wallet }> {
    if (deposit.amountMinor === null) throw new Error("Confirmed deposit has no amount.");
    // Ensure the nested wallet document exists before the atomic update below.
    await this.getWallet(deposit.userId);
    try {
      await this.document.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.options.tableName,
                Key: { pk: `DEPOSIT#${deposit.txHash.toLowerCase()}`, sk: "META" },
                UpdateExpression: "SET #data = :deposit",
                ConditionExpression: "#data.#status = :pending",
                ExpressionAttributeNames: { "#data": "data", "#status": "status" },
                ExpressionAttributeValues: { ":deposit": deposit, ":pending": "pending" },
              },
            },
            {
              Update: {
                TableName: this.options.tableName,
                Key: { pk: `USER#${deposit.userId}`, sk: "WALLET" },
                UpdateExpression:
                  "SET #data.#balance = #data.#balance + :amount, #data.#receipt = :receipt, #data.#transactions = list_append(:transaction, #data.#transactions)",
                ExpressionAttributeNames: {
                  "#data": "data",
                  "#balance": "balanceMinor",
                  "#receipt": "receipt",
                  "#transactions": "transactions",
                },
                ExpressionAttributeValues: {
                  ":amount": deposit.amountMinor,
                  ":receipt": receipt,
                  ":transaction": [transaction],
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      const existing = await this.getWalletDeposit(deposit.txHash);
      if (existing?.status !== "confirmed") throw error;
      return { deposit: existing, wallet: await this.getWallet(existing.userId) };
    }
    return { deposit, wallet: await this.getWallet(deposit.userId) };
  }

  async getMandate(userId: string): Promise<Mandate> {
    const mandate = await this.getState(userId, "MANDATE", defaultMandate);
    return {
      autoApprove: mandate.autoApprove,
      itemCap: mandate.itemCap,
      actCap: mandate.actCap,
    };
  }

  async putMandate(userId: string, mandate: Mandate): Promise<void> {
    await this.putState(userId, "MANDATE", mandate);
  }

  async getSettings(userId: string): Promise<Settings> {
    const settings = await this.getState(userId, "SETTINGS", defaultSettings);
    return {
      region: settings.region,
      dataRetention: settings.dataRetention,
      shippingAddress: settings.shippingAddress ?? null,
    };
  }

  async putSettings(userId: string, settings: Settings): Promise<void> {
    await this.putState(userId, "SETTINGS", settings);
  }

  async getProfile(userId: string): Promise<Profile> {
    return this.getState(userId, "PROFILE", defaultProfile);
  }

  async claimPurchase(activityId: string, idempotencyKey: string): Promise<PurchaseClaim> {
    const item = {
      pk: `PURCHASE#${activityId}`,
      sk: "LOCK",
      entity: "purchase-lock",
      key: idempotencyKey,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.document.send(
        new PutCommand({
          TableName: this.options.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return { claimed: true, key: idempotencyKey };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      const existing = await this.get<{ key: string }>(item.pk, item.sk);
      return { claimed: false, key: existing?.key ?? "unknown" };
    }
  }

  async getPurchaseClaim(activityId: string): Promise<PurchaseClaim | null> {
    const existing = await this.get<{ key: string }>(`PURCHASE#${activityId}`, "LOCK");
    return existing ? { claimed: false, key: existing.key } : null;
  }

  async getPurchaseRun(activityId: string): Promise<PurchaseRun | null> {
    const stored = await this.get<Stored<PurchaseRun>>(`ACTIVITY#${activityId}`, "PURCHASE");
    return stored?.data ?? null;
  }

  async putPurchaseRun(run: PurchaseRun): Promise<void> {
    await this.put<Stored<PurchaseRun>>({
      pk: `ACTIVITY#${run.activityId}`,
      sk: "PURCHASE",
      entity: "purchase-run",
      data: run,
    });
  }

  private async getState<T>(userId: string, key: string, fallback: () => T): Promise<T> {
    const stored = await this.get<Stored<T>>(`USER#${userId}`, key);
    if (stored) return stored.data;
    const value = fallback();
    await this.putState(userId, key, value);
    return value;
  }

  private async putState<T>(userId: string, key: string, data: T): Promise<void> {
    await this.put<Stored<T>>({
      pk: `USER#${userId}`,
      sk: key,
      entity: key.toLowerCase(),
      data,
    });
  }

  private depositItem(deposit: WalletDeposit): Stored<WalletDeposit> {
    return {
      pk: `DEPOSIT#${deposit.txHash.toLowerCase()}`,
      sk: "META",
      entity: "wallet-deposit",
      data: deposit,
      gsi1pk: `USER#${deposit.userId}`,
      gsi1sk: `${deposit.createdAt}#${deposit.txHash.toLowerCase()}`,
    };
  }

  private async get<T>(pk: string, sk: string): Promise<T | null> {
    const result = await this.document.send(
      new GetCommand({
        TableName: this.options.tableName,
        Key: { pk, sk },
        ConsistentRead: true,
      }),
    );
    return (result.Item as T | undefined) ?? null;
  }

  private async put<T extends object>(item: T): Promise<void> {
    await this.document.send(
      new PutCommand({
        TableName: this.options.tableName,
        Item: item as Record<string, unknown>,
      }),
    );
  }
}
