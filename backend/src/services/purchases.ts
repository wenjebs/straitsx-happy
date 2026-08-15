import type { Config } from "../config.js";
import type {
  Activity,
  ExecutionRow,
  Listing,
  LogLine,
  Mandate,
  Settings,
  ShortlistPick,
  Wallet,
  WishlistItem,
} from "../domain.js";
import { displayTime, formatMinor, logTime, newId } from "../domain.js";
import { asMessage, HttpError } from "../errors.js";
import type { EventHub } from "../events.js";
import type { IssuedCard, PaymentProvider } from "../providers/payment.js";
import type { Repository } from "../repository.js";

interface PurchaseContext {
  activity: Activity;
  mandate: Mandate;
  settings: Settings;
  wallet: Wallet;
  idempotencyKey: string;
}

export class PurchaseService {
  constructor(
    private readonly repository: Repository,
    private readonly events: EventHub,
    private readonly payments: PaymentProvider,
    private readonly config: Pick<
      Config,
      "PAYMENT_MIN_MINOR" | "PAYMENT_MAX_MINOR" | "PAYMENT_ATTEMPTS_PER_LISTING"
    >,
  ) {}

  async start(activityId: string, idempotencyKey: string): Promise<Activity> {
    const activity = await this.repository.getActivity(activityId);
    if (!activity) throw new HttpError(404, `Activity ${activityId} was not found.`);

    /* A duplicate request may arrive after the first call already moved to exec. */
    const existingClaim = await this.repository.getPurchaseClaim(activityId);
    if (existingClaim) {
      if (existingClaim.key !== idempotencyKey) {
        throw new HttpError(409, "A purchase is already running for this activity.");
      }
      return activity;
    }

    if (activity.status !== "live" || activity.stage !== "shortlist") {
      throw new HttpError(409, "This activity is not awaiting purchase confirmation.");
    }
    if (activity.shortlist.length === 0) throw new HttpError(409, "The shortlist is empty.");

    const [mandate, settings, wallet] = await Promise.all([
      this.repository.getMandate(activity.userId),
      this.repository.getSettings(activity.userId),
      this.repository.getWallet(activity.userId),
    ]);
    this.assertMandate(activity, mandate, wallet);
    if (this.payments.mode === "disabled") {
      throw new HttpError(
        503,
        "Mandate checks passed, but the real payment service is not configured. Set PAYMENT_API_BASE_URL and its API credentials.",
      );
    }

    const claim = await this.repository.claimPurchase(activityId, idempotencyKey);
    if (!claim.claimed) {
      if (claim.key !== idempotencyKey) {
        throw new HttpError(409, "A purchase is already running for this activity.");
      }
      return (await this.repository.getActivity(activityId)) ?? activity;
    }

    activity.stage = "exec";
    activity.execution = activity.shortlist.map((pick) => ({
      itemId: pick.itemId,
      step: 0,
      state: "queued" as const,
    }));
    activity.log = [];
    await this.repository.putActivity(activity);
    this.snapshot(activity);

    const context: PurchaseContext = { activity, mandate, settings, wallet, idempotencyKey };
    void this.execute(context).catch((error) => this.failExecution(context, error));
    return activity;
  }

  private async execute(context: PurchaseContext): Promise<void> {
    for (const pick of context.activity.shortlist) {
      const item = context.activity.wishlist.find((row) => row.id === pick.itemId);
      if (!item) throw new Error(`Shortlist item ${pick.itemId} has no wishlist item.`);
      const purchased = await this.tryCandidates(context, item, pick);
      if (!purchased) {
        throw new Error(
          `Every compliant candidate failed for ${item.name}. No further cards were issued.`,
        );
      }
    }

    const completedAt = displayTime();
    context.activity.status = "completed";
    context.activity.completedAt = completedAt;
    context.activity.displayTs = completedAt;
    context.activity.totalMinor = context.activity.shortlist.reduce(
      (sum, pick) => sum + pick.listing.amountMinor,
      0,
    );
    context.activity.archiveLines = context.activity.shortlist.map((pick) => ({
      name: context.activity.wishlist.find((item) => item.id === pick.itemId)?.name ?? pick.itemId,
      seller: pick.listing.seller,
      price: pick.listing.price,
    }));
    await this.repository.putActivity(context.activity);
    this.events.emit(context.activity.id, {
      type: "activity.completed",
      completedAt,
      totalMinor: context.activity.totalMinor,
    });
    this.events.emit(context.activity.id, { type: "wallet.updated", wallet: context.wallet });
    this.snapshot(context.activity);
  }

  private async tryCandidates(
    context: PurchaseContext,
    item: WishlistItem,
    pick: ShortlistPick,
  ): Promise<boolean> {
    const approvedMinor = pick.listing.amountMinor;
    const candidates = [pick.listing, ...(pick.alternates ?? [])];

    for (const [candidateIndex, listing] of candidates.entries()) {
      if (listing.amountMinor > approvedMinor) {
        await this.appendSystemLog(
          context.activity,
          item,
          `skipped alternate ${listing.title} · ${listing.price} exceeds approved ${formatMinor(approvedMinor)}`,
        );
        continue;
      }
      try {
        this.assertListing(item, listing, context.mandate);
      } catch (error) {
        await this.appendSystemLog(
          context.activity,
          item,
          `skipped non-compliant alternate · ${asMessage(error)}`,
        );
        continue;
      }

      for (let attempt = 0; attempt < this.config.PAYMENT_ATTEMPTS_PER_LISTING; attempt += 1) {
        const attemptKey = `${context.idempotencyKey}:${item.id}:${candidateIndex}:${attempt}`;
        let card: IssuedCard | null = null;
        try {
          card = await this.payments.issueCard({
            activity: context.activity,
            item,
            listing,
            mandate: context.mandate,
            settings: context.settings,
            idempotencyKey: attemptKey,
          });
          context.wallet.cards.unshift({
            pan: `•••• •••• ${card.last4}`,
            amount: listing.price,
            status: "issued",
          });
          await this.repository.putWallet(context.activity.userId, context.wallet);
          await this.emitStep(
            context.activity,
            item,
            1,
            "live",
            `card •••• ${card.last4} issued · limit ${listing.price}`,
          );

          const checkout = await this.payments.prepareCheckout({
            activity: context.activity,
            item,
            listing,
            mandate: context.mandate,
            settings: context.settings,
            idempotencyKey: attemptKey,
            card,
          });
          await this.emitStep(
            context.activity,
            item,
            2,
            "live",
            `${checkout.merchant}/checkout · autofill ok`,
          );

          await this.emitStep(context.activity, item, 3, "live", `placing order ${listing.price}`);
          const order = await this.payments.placeOrder({
            activity: context.activity,
            item,
            listing,
            mandate: context.mandate,
            settings: context.settings,
            idempotencyKey: attemptKey,
            card,
            checkout,
          });

          const walletCard = context.wallet.cards.find(
            (row) => row.pan.endsWith(card?.last4 ?? "") && row.status === "issued",
          );
          if (walletCard) walletCard.status = "used";
          context.wallet.balanceMinor -= listing.amountMinor;
          context.wallet.transactions.unshift({
            id: newId("txn"),
            ts: new Intl.DateTimeFormat("en-SG", {
              timeZone: "Asia/Singapore",
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }).format(new Date()),
            label: `Card authorisation · ${listing.seller}`,
            ref: `order ${order.orderId}`,
            amount: `−${listing.price}`,
            debit: true,
          });
          await this.repository.putWallet(context.activity.userId, context.wallet);

          pick.listing = listing;
          pick.reSearched = candidateIndex > 0;
          await this.emitStep(
            context.activity,
            item,
            4,
            "purchased",
            `order #${order.orderId} confirmed · card used`,
          );
          this.events.emit(context.activity.id, { type: "wallet.updated", wallet: context.wallet });
          return true;
        } catch (error) {
          if (card) {
            const walletCard = context.wallet.cards.find(
              (row) => row.pan.endsWith(card?.last4 ?? "") && row.status === "issued",
            );
            if (walletCard) walletCard.status = "expired";
            await this.repository.putWallet(context.activity.userId, context.wallet);
          }
          await this.appendSystemLog(
            context.activity,
            item,
            `${listing.title} · attempt ${attempt + 1} failed: ${asMessage(error)}`,
          );
        }
      }
    }
    return false;
  }

  private assertMandate(activity: Activity, mandate: Mandate, wallet: Wallet): void {
    const totalMinor = activity.shortlist.reduce((sum, pick) => sum + pick.listing.amountMinor, 0);
    const actCapMinor = mandate.actCap * 100;
    if (totalMinor > actCapMinor) {
      throw new HttpError(
        422,
        `Mandate denied purchase: ${formatMinor(totalMinor)} exceeds the per-activity cap ${formatMinor(actCapMinor)}.`,
      );
    }
    if (totalMinor > wallet.balanceMinor) {
      throw new HttpError(
        422,
        `Mandate denied purchase: wallet balance ${formatMinor(wallet.balanceMinor)} is below ${formatMinor(totalMinor)}.`,
      );
    }
    for (const pick of activity.shortlist) {
      const item = activity.wishlist.find((row) => row.id === pick.itemId);
      if (!item) throw new HttpError(422, `Shortlist item ${pick.itemId} has no wishlist record.`);
      this.assertListing(item, pick.listing, mandate);
    }
  }

  private assertListing(item: WishlistItem, listing: Listing, mandate: Mandate): void {
    const itemCapMinor = mandate.itemCap * 100;
    if (listing.amountMinor > itemCapMinor) {
      throw new HttpError(
        422,
        `Mandate denied ${item.name}: ${listing.price} exceeds the per-item cap ${formatMinor(itemCapMinor)}.`,
      );
    }
    const rule = mandate.categoryRules[item.category ?? "General"] ?? "allowed";
    if (rule === "blocked") {
      throw new HttpError(
        422,
        `Mandate denied ${item.name}: category ${item.category} is blocked.`,
      );
    }
    if (
      listing.amountMinor < this.config.PAYMENT_MIN_MINOR ||
      listing.amountMinor > this.config.PAYMENT_MAX_MINOR
    ) {
      throw new HttpError(
        422,
        `Payment rail denied ${item.name}: ${listing.price} is outside the issuable range ${formatMinor(this.config.PAYMENT_MIN_MINOR)}–${formatMinor(this.config.PAYMENT_MAX_MINOR)}.`,
      );
    }
  }

  private async emitStep(
    activity: Activity,
    item: WishlistItem,
    step: number,
    state: ExecutionRow["state"],
    text: string,
  ): Promise<void> {
    const row: ExecutionRow = { itemId: item.id, step, state };
    activity.execution = activity.execution.map((current) =>
      current.itemId === item.id ? row : current,
    );
    const line = this.logLine(item, text);
    activity.log.push(line);
    await this.repository.putActivity(activity);
    this.events.emit(activity.id, { type: "exec.step", row });
    this.events.emit(activity.id, { type: "log.line", line });
  }

  private async appendSystemLog(
    activity: Activity,
    item: WishlistItem,
    text: string,
  ): Promise<void> {
    const line = this.logLine(item, text);
    activity.log.push(line);
    await this.repository.putActivity(activity);
    this.events.emit(activity.id, { type: "log.line", line });
  }

  private logLine(item: WishlistItem, text: string): LogLine {
    return {
      id: newId("log"),
      ts: logTime(),
      tag: item.short,
      hueIndex: item.hueIndex,
      text,
    };
  }

  private async failExecution(context: PurchaseContext, error: unknown): Promise<void> {
    context.activity.status = "cancelled";
    const line: LogLine = {
      id: newId("log"),
      ts: logTime(),
      tag: "SYS",
      hueIndex: 0,
      text: `purchase stopped · ${asMessage(error)}`,
    };
    context.activity.log.push(line);
    await this.repository.putActivity(context.activity);
    this.events.emit(context.activity.id, { type: "log.line", line });
    this.events.emit(context.activity.id, { type: "wallet.updated", wallet: context.wallet });
    this.snapshot(context.activity);
  }

  private snapshot(activity: Activity): void {
    this.events.emit(activity.id, {
      type: "activity.snapshot",
      activity: structuredClone(activity),
    });
  }
}
