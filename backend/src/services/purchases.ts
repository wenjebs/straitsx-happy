import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type {
  Activity,
  ExecutionRow,
  Listing,
  LogLine,
  Mandate,
  PurchaseRun,
  Wallet,
  WishlistItem,
} from "../domain.js";
import { displayTime, formatMinor, logTime, newId } from "../domain.js";
import { asMessage, HttpError } from "../errors.js";
import type { EventHub } from "../events.js";
import type { CardProvider, IssuedCard } from "../providers/card.js";
import type { PurchaseAgentProvider } from "../providers/purchaseAgent.js";
import type { Repository } from "../repository.js";
import type { PurchaseAgentCallback } from "../schemas.js";

export class PurchaseService {
  constructor(
    private readonly repository: Repository,
    private readonly events: EventHub,
    private readonly cards: CardProvider,
    private readonly purchaseAgents: PurchaseAgentProvider,
    private readonly config: Pick<
      Config,
      "PUBLIC_BASE_URL" | "PAYMENT_MIN_MINOR" | "PAYMENT_MAX_MINOR" | "PAYMENT_ATTEMPTS_PER_LISTING"
    >,
  ) {}

  async start(activityId: string, idempotencyKey: string): Promise<Activity> {
    const activity = await this.getActivity(activityId);
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
    if (this.cards.mode === "disabled") {
      throw new HttpError(503, "The StraitsX card provider is not configured.");
    }
    if (this.purchaseAgents.mode === "disabled") {
      throw new HttpError(503, "The Closer purchase agent is not configured.");
    }

    const [mandate, settings, wallet] = await Promise.all([
      this.repository.getMandate(activity.userId),
      this.repository.getSettings(activity.userId),
      this.repository.getWallet(activity.userId),
    ]);
    this.assertMandate(activity, mandate, wallet);
    if (
      (this.cards.mode === "local" || this.purchaseAgents.mode === "local") &&
      !settings.sandbox
    ) {
      throw new HttpError(
        409,
        "Local payment failsafes require Sandbox mode. Enable it in Settings before purchasing.",
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
      action: "waiting for Closer",
    }));
    activity.log = [];
    const run: PurchaseRun = {
      activityId,
      userId: activity.userId,
      idempotencyKey,
      status: "running",
      itemIndex: 0,
      candidateIndex: 0,
      attemptIndex: 0,
      processedEventIds: [],
      updatedAt: new Date().toISOString(),
    };
    await Promise.all([this.repository.putActivity(activity), this.repository.putPurchaseRun(run)]);
    this.snapshot(activity);
    void this.startNextAttempt(activityId).catch((error) => this.failRun(activityId, error));
    return activity;
  }

  async handleAgentEvent(activityId: string, event: PurchaseAgentCallback): Promise<Activity> {
    const [activity, run] = await Promise.all([
      this.getActivity(activityId),
      this.repository.getPurchaseRun(activityId),
    ]);
    if (!run) throw new HttpError(404, `Purchase run for ${activityId} was not found.`);
    if (run.processedEventIds.includes(event.eventId)) return activity;
    if (run.status !== "running" || activity.stage !== "exec") {
      throw new HttpError(409, `Purchase run for ${activityId} is not running.`);
    }
    const pick = activity.shortlist[run.itemIndex];
    const item = pick && activity.wishlist.find((row) => row.id === pick.itemId);
    if (!pick || !item) throw new HttpError(409, "Purchase run cursor is outside the shortlist.");
    if (event.attemptId !== run.attemptId || event.itemId !== item.id) {
      throw new HttpError(409, "Purchase callback belongs to a stale or unknown attempt.");
    }

    run.processedEventIds = [...run.processedEventIds.slice(-99), event.eventId];
    run.updatedAt = new Date().toISOString();

    switch (event.type) {
      case "browser.started":
        await this.emitStep(
          activity,
          item,
          2,
          "live",
          event.message ?? "Closer opened the listing",
          event.liveStreamUrl,
        );
        await this.repository.putPurchaseRun(run);
        break;
      case "checkout.prepared":
        await this.emitStep(activity, item, 2, "live", event.message ?? "checkout prepared");
        await this.repository.putPurchaseRun(run);
        break;
      case "order.placing":
        await this.emitStep(activity, item, 3, "live", event.message ?? "placing order");
        await this.repository.putPurchaseRun(run);
        break;
      case "order.confirmed":
        await this.confirmOrder(activity, run, item, event.orderId, event.message);
        break;
      case "purchase.failed":
        await this.expireCurrentCard(run);
        await this.appendSystemLog(
          activity,
          item,
          `attempt ${run.attemptIndex + 1} failed · ${event.message}`,
        );
        if (event.retryable) run.attemptIndex += 1;
        else {
          run.candidateIndex += 1;
          run.attemptIndex = 0;
        }
        this.clearAttempt(run);
        await this.repository.putPurchaseRun(run);
        void this.startNextAttempt(activityId).catch((error) => this.failRun(activityId, error));
        break;
    }
    return activity;
  }

  /** Called by Closer to pull its exact-value card after accepting the job. */
  async claimCard(activityId: string, attemptId: string, grantToken: string): Promise<IssuedCard> {
    const [activity, run] = await Promise.all([
      this.getActivity(activityId),
      this.repository.getPurchaseRun(activityId),
    ]);
    if (run?.status !== "running" || activity.stage !== "exec") {
      throw new HttpError(409, "This purchase attempt is not running.");
    }
    if (run.attemptId !== attemptId) {
      throw new HttpError(409, "This card grant belongs to a stale purchase attempt.");
    }
    if (!run.cardGrantHash || !safeHashEqual(hashGrant(grantToken), run.cardGrantHash)) {
      throw new HttpError(401, "Card grant token is missing or invalid.");
    }
    if (!run.cardGrantExpiresAt || Date.parse(run.cardGrantExpiresAt) <= Date.now()) {
      throw new HttpError(410, "Card grant has expired.");
    }

    const pick = activity.shortlist[run.itemIndex];
    const item = pick && activity.wishlist.find((row) => row.id === pick.itemId);
    const listing = pick && [pick.listing, ...(pick.alternates ?? [])][run.candidateIndex];
    if (!item || !listing) throw new HttpError(409, "Purchase cursor is no longer valid.");
    const [mandate, settings, wallet] = await Promise.all([
      this.repository.getMandate(activity.userId),
      this.repository.getSettings(activity.userId),
      this.repository.getWallet(activity.userId),
    ]);
    this.assertListing(item, listing, mandate);
    if (listing.amountMinor > wallet.balanceMinor) {
      throw new HttpError(422, "Wallet balance is below the exact card amount.");
    }
    if (this.cards.mode === "local" && !settings.sandbox) {
      throw new HttpError(409, "Local card claims require Sandbox mode.");
    }

    const attemptKey = `${run.idempotencyKey}:${item.id}:${run.candidateIndex}:${run.attemptIndex}`;
    const firstClaim = !run.cardClaimedAt;
    const card = await this.cards.issueCard({
      activity,
      item,
      listing,
      mandate,
      settings,
      idempotencyKey: attemptKey,
    });
    if (run.cardId && run.cardId !== card.cardId) {
      throw new HttpError(502, "Card provider violated idempotency for this attempt.");
    }
    run.cardId = card.cardId;
    run.cardLast4 = card.last4;
    run.cardClaimedAt ??= new Date().toISOString();
    run.updatedAt = new Date().toISOString();
    if (!wallet.cards.some((row) => row.pan.endsWith(card.last4))) {
      wallet.cards.unshift({
        pan: `•••• •••• ${card.last4}`,
        amount: listing.price,
        status: "issued",
      });
    }
    await Promise.all([
      this.repository.putWallet(activity.userId, wallet),
      this.repository.putPurchaseRun(run),
    ]);
    if (firstClaim) {
      this.events.emit(activity.id, { type: "wallet.updated", wallet });
      await this.emitStep(
        activity,
        item,
        1,
        "live",
        `Closer claimed exact-value card •••• ${card.last4} · limit ${listing.price}`,
      );
    }
    return card;
  }

  private async startNextAttempt(activityId: string): Promise<void> {
    const [activity, run] = await Promise.all([
      this.getActivity(activityId),
      this.repository.getPurchaseRun(activityId),
    ]);
    if (run?.status !== "running" || run.attemptId) return;
    const [mandate, settings] = await Promise.all([
      this.repository.getMandate(activity.userId),
      this.repository.getSettings(activity.userId),
    ]);

    while (run.itemIndex < activity.shortlist.length) {
      const pick = activity.shortlist[run.itemIndex];
      if (!pick) break;
      const item = activity.wishlist.find((row) => row.id === pick.itemId);
      if (!item) throw new Error(`Shortlist item ${pick.itemId} has no wishlist record.`);
      const candidates = [pick.listing, ...(pick.alternates ?? [])];
      if (run.attemptIndex >= this.config.PAYMENT_ATTEMPTS_PER_LISTING) {
        run.candidateIndex += 1;
        run.attemptIndex = 0;
      }
      const listing = candidates[run.candidateIndex];
      if (!listing) {
        throw new Error(`Every compliant candidate failed for ${item.name}.`);
      }
      if (listing.amountMinor > pick.listing.amountMinor) {
        await this.appendSystemLog(
          activity,
          item,
          `skipped ${listing.title} · ${listing.price} exceeds the approved amount`,
        );
        run.candidateIndex += 1;
        run.attemptIndex = 0;
        continue;
      }
      try {
        this.assertListing(item, listing, mandate);
      } catch (error) {
        await this.appendSystemLog(activity, item, `skipped candidate · ${asMessage(error)}`);
        run.candidateIndex += 1;
        run.attemptIndex = 0;
        continue;
      }

      const attemptId = newId("attempt");
      const attemptKey = `${run.idempotencyKey}:${item.id}:${run.candidateIndex}:${run.attemptIndex}`;
      const grantToken = `card-grant-${crypto.randomUUID()}`;
      const grantExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      try {
        run.attemptId = attemptId;
        run.cardGrantHash = hashGrant(grantToken);
        run.cardGrantExpiresAt = grantExpiresAt;
        run.updatedAt = new Date().toISOString();
        await this.repository.putPurchaseRun(run);
        await this.purchaseAgents.startPurchase({
          activityId,
          attemptId,
          item,
          listing,
          cardGrant: {
            claimUrl: `${this.config.PUBLIC_BASE_URL.replace(/\/$/, "")}/v1/integrations/purchases/${encodeURIComponent(activityId)}/attempts/${encodeURIComponent(attemptId)}/card`,
            token: grantToken,
            amountMinor: listing.amountMinor,
            currency: "SGD",
            expiresAt: grantExpiresAt,
          },
          sandbox: settings.sandbox,
          idempotencyKey: attemptKey,
        });
        return;
      } catch (error) {
        await this.expireCurrentCard(run);
        await this.appendSystemLog(
          activity,
          item,
          `could not start Closer attempt ${run.attemptIndex + 1} · ${asMessage(error)}`,
        );
        run.attemptIndex += 1;
        this.clearAttempt(run);
        await this.repository.putPurchaseRun(run);
      }
    }
    throw new Error("Purchase run reached an invalid completion state.");
  }

  private async confirmOrder(
    activity: Activity,
    run: PurchaseRun,
    item: WishlistItem,
    orderId: string,
    message?: string,
  ): Promise<void> {
    const pick = activity.shortlist[run.itemIndex];
    if (!pick) throw new Error("Confirmed item is outside the shortlist.");
    const listing = [pick.listing, ...(pick.alternates ?? [])][run.candidateIndex];
    if (!listing) throw new Error("Confirmed listing is outside the candidate list.");
    if (!run.cardId || !run.cardLast4 || !run.cardClaimedAt) {
      throw new HttpError(409, "Closer cannot confirm an order before claiming its card.");
    }
    const wallet = await this.repository.getWallet(activity.userId);
    const walletCard = wallet.cards.find(
      (row) => row.pan.endsWith(run.cardLast4 ?? "") && row.status === "issued",
    );
    if (walletCard) walletCard.status = "used";
    wallet.balanceMinor -= listing.amountMinor;
    wallet.transactions.unshift({
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
      ref: `order ${orderId}`,
      amount: `−${listing.price}`,
      debit: true,
    });
    pick.listing = listing;
    pick.reSearched = run.candidateIndex > 0;
    await this.repository.putWallet(activity.userId, wallet);
    await this.emitStep(
      activity,
      item,
      4,
      "purchased",
      message ? `${message} · order #${orderId}` : `order #${orderId} confirmed · card used`,
    );
    this.events.emit(activity.id, { type: "wallet.updated", wallet });

    run.itemIndex += 1;
    run.candidateIndex = 0;
    run.attemptIndex = 0;
    this.clearAttempt(run);
    run.updatedAt = new Date().toISOString();
    if (run.itemIndex >= activity.shortlist.length) {
      run.status = "completed";
      const completedAt = displayTime();
      activity.status = "completed";
      activity.completedAt = completedAt;
      activity.displayTs = completedAt;
      activity.totalMinor = activity.shortlist.reduce(
        (sum, row) => sum + row.listing.amountMinor,
        0,
      );
      activity.archiveLines = activity.shortlist.map((row) => ({
        name:
          activity.wishlist.find((wishlistItem) => wishlistItem.id === row.itemId)?.name ??
          row.itemId,
        seller: row.listing.seller,
        price: row.listing.price,
      }));
      await Promise.all([
        this.repository.putActivity(activity),
        this.repository.putPurchaseRun(run),
      ]);
      this.events.emit(activity.id, {
        type: "activity.completed",
        completedAt,
        totalMinor: activity.totalMinor,
      });
      this.snapshot(activity);
      return;
    }
    await this.repository.putPurchaseRun(run);
    void this.startNextAttempt(activity.id).catch((error) => this.failRun(activity.id, error));
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
    if ((mandate.categoryRules[item.category ?? "General"] ?? "allowed") === "blocked") {
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

  private async expireCurrentCard(run: PurchaseRun): Promise<void> {
    if (!run.cardLast4) return;
    const wallet = await this.repository.getWallet(run.userId);
    const card = wallet.cards.find(
      (row) => row.pan.endsWith(run.cardLast4 ?? "") && row.status === "issued",
    );
    if (card) card.status = "expired";
    await this.repository.putWallet(run.userId, wallet);
    this.events.emit(run.activityId, { type: "wallet.updated", wallet });
  }

  private clearAttempt(run: PurchaseRun): void {
    delete run.attemptId;
    delete run.cardGrantHash;
    delete run.cardGrantExpiresAt;
    delete run.cardClaimedAt;
    delete run.cardId;
    delete run.cardLast4;
    run.updatedAt = new Date().toISOString();
  }

  private async emitStep(
    activity: Activity,
    item: WishlistItem,
    step: number,
    state: ExecutionRow["state"],
    text: string,
    liveStreamUrl?: string,
  ): Promise<void> {
    const previous = activity.execution.find((row) => row.itemId === item.id);
    const retainedStream = liveStreamUrl ?? previous?.liveStreamUrl;
    const row: ExecutionRow = {
      itemId: item.id,
      step,
      state,
      action: text,
      ...(retainedStream ? { liveStreamUrl: retainedStream } : {}),
    };
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

  private async failRun(activityId: string, error: unknown): Promise<void> {
    const [activity, run] = await Promise.all([
      this.repository.getActivity(activityId),
      this.repository.getPurchaseRun(activityId),
    ]);
    if (!activity || !run || run.status !== "running") return;
    await this.expireCurrentCard(run);
    run.status = "failed";
    run.updatedAt = new Date().toISOString();
    activity.status = "cancelled";
    const line: LogLine = {
      id: newId("log"),
      ts: logTime(),
      tag: "SYS",
      hueIndex: 0,
      text: `purchase stopped · ${asMessage(error)}`,
    };
    activity.log.push(line);
    await Promise.all([this.repository.putActivity(activity), this.repository.putPurchaseRun(run)]);
    this.events.emit(activity.id, { type: "log.line", line });
    this.snapshot(activity);
  }

  private async getActivity(id: string): Promise<Activity> {
    const activity = await this.repository.getActivity(id);
    if (!activity) throw new HttpError(404, `Activity ${id} was not found.`);
    return activity;
  }

  private snapshot(activity: Activity): void {
    this.events.emit(activity.id, {
      type: "activity.snapshot",
      activity: structuredClone(activity),
    });
  }
}

function hashGrant(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
