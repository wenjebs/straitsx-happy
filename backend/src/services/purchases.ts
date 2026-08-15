import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type {
  Activity,
  PurchaseAttempt,
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
      attempts: {},
      progress: Object.fromEntries(
        activity.shortlist.map((pick) => [
          pick.itemId,
          { candidateIndex: 0, attemptIndex: 0, done: false },
        ]),
      ),
      processedEventIds: [],
      updatedAt: new Date().toISOString(),
    };
    await Promise.all([
      this.repository.putActivity(activity, "purchase.started"),
      this.repository.putPurchaseRun(run),
    ]);
    this.snapshot(activity);
    void this.startAttempts(activityId).catch((error) => this.failRun(activityId, error));
    return activity;
  }

  async cancel(activityId: string): Promise<Activity> {
    const [activity, run] = await Promise.all([
      this.getActivity(activityId),
      this.repository.getPurchaseRun(activityId),
    ]);
    if (activity.status !== "live" || activity.stage !== "exec") {
      throw new HttpError(409, "This activity has no live purchase to cancel.");
    }

    let agentWarning = "";
    if (run?.status === "running") {
      // Every live attempt, not just one: with several browsers in flight, cancelling the first
      // and leaving the rest running is how a cancelled activity still spends money.
      const live = Object.values(run.attempts);
      run.status = "cancelled";
      run.updatedAt = new Date().toISOString();
      await this.repository.putPurchaseRun(run);
      for (const attempt of live) {
        await this.expireAttemptCard(run, attempt);
        this.clearAttempt(run, attempt.attemptId);
      }
      await this.repository.putPurchaseRun(run);
      const failures: string[] = [];
      for (const attempt of live.length > 0 ? live : [undefined]) {
        try {
          await this.purchaseAgents.cancelPurchase({
            activityId,
            ...(attempt ? { attemptId: attempt.attemptId } : {}),
            reason: "Cancelled by the user in Happy.",
          });
        } catch (error) {
          failures.push(asMessage(error));
        }
      }
      if (failures.length > 0) {
        agentWarning = ` · remote Closer did not acknowledge cancellation: ${failures.join("; ")}`;
      }
    }

    const purchasedIds = new Set(
      activity.execution.filter((row) => row.state === "purchased").map((row) => row.itemId),
    );
    activity.archiveLines = activity.shortlist
      .filter((pick) => purchasedIds.has(pick.itemId))
      .map((pick) => ({
        name: activity.wishlist.find((item) => item.id === pick.itemId)?.name ?? pick.itemId,
        seller: pick.listing.seller,
        price: pick.listing.price,
      }));
    activity.totalMinor = activity.shortlist
      .filter((pick) => purchasedIds.has(pick.itemId))
      .reduce((sum, pick) => sum + pick.listing.amountMinor, 0);
    activity.status = "cancelled";
    activity.searchPlaying = false;
    activity.completedAt = displayTime();
    activity.displayTs = activity.completedAt;
    const line: LogLine = {
      id: newId("log"),
      ts: logTime(),
      tag: "SYS",
      hueIndex: 0,
      text: `purchase cancelled by user · unused card access invalidated${agentWarning}`,
    };
    activity.log.push(line);
    await this.repository.putActivity(activity, "purchase.cancelled");
    this.events.emit(activity.id, { type: "log.line", line });
    this.snapshot(activity);
    return activity;
  }

  async handleAgentEvent(activityId: string, event: PurchaseAgentCallback): Promise<Activity> {
    const [activity, run] = await Promise.all([
      this.getActivity(activityId),
      this.repository.getPurchaseRun(activityId),
    ]);
    if (!run) throw new HttpError(404, `Purchase run for ${activityId} was not found.`);
    if (run.processedEventIds.includes(event.eventId)) return activity;
    if (run.status !== "running" || activity.status !== "live" || activity.stage !== "exec") {
      throw new HttpError(409, `Purchase run for ${activityId} is not running.`);
    }
    // Routed by the attemptId the callback carries, never by a shared cursor. With several
    // attempts live at once a cursor would attribute one item's event to whichever happened to be
    // current.
    const attempt = run.attempts[event.attemptId];
    if (!attempt || event.itemId !== attempt.itemId) {
      throw new HttpError(409, "Purchase callback belongs to a stale or unknown attempt.");
    }
    const pick = activity.shortlist.find((row) => row.itemId === attempt.itemId);
    const item = pick && activity.wishlist.find((row) => row.id === pick.itemId);
    if (!pick || !item) throw new HttpError(409, "Purchase attempt is outside the shortlist.");

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
        await this.confirmOrder(activity, run, attempt, item, event.orderId, event.message);
        break;
      case "purchase.failed": {
        await this.expireAttemptCard(run, attempt);
        await this.appendSystemLog(
          activity,
          item,
          `attempt ${attempt.attemptIndex + 1} failed · ${event.message}`,
        );
        const progress = this.progressFor(run, attempt.itemId);
        if (event.retryable) progress.attemptIndex += 1;
        else {
          progress.candidateIndex += 1;
          progress.attemptIndex = 0;
        }
        this.clearAttempt(run, attempt.attemptId);
        await this.repository.putPurchaseRun(run);
        void this.startAttempts(activityId).catch((error) => this.failRun(activityId, error));
        break;
      }
    }
    return activity;
  }

  /** Called by Closer to pull its exact-value card after accepting the job. */
  async claimCard(activityId: string, attemptId: string, grantToken: string): Promise<IssuedCard> {
    const [activity, run] = await Promise.all([
      this.getActivity(activityId),
      this.repository.getPurchaseRun(activityId),
    ]);
    if (run?.status !== "running" || activity.status !== "live" || activity.stage !== "exec") {
      throw new HttpError(409, "This purchase attempt is not running.");
    }
    const attempt = run.attempts[attemptId];
    if (!attempt) {
      throw new HttpError(409, "This card grant belongs to a stale purchase attempt.");
    }
    if (!attempt.cardGrantHash || !safeHashEqual(hashGrant(grantToken), attempt.cardGrantHash)) {
      throw new HttpError(401, "Card grant token is missing or invalid.");
    }
    if (!attempt.cardGrantExpiresAt || Date.parse(attempt.cardGrantExpiresAt) <= Date.now()) {
      throw new HttpError(410, "Card grant has expired.");
    }

    const pick = activity.shortlist.find((row) => row.itemId === attempt.itemId);
    const item = pick && activity.wishlist.find((row) => row.id === pick.itemId);
    const listing = pick && [pick.listing, ...(pick.alternates ?? [])][attempt.candidateIndex];
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

    const attemptKey = `${run.idempotencyKey}:${item.id}:${attempt.candidateIndex}:${attempt.attemptIndex}`;
    const firstClaim = !attempt.cardClaimedAt;
    const card = await this.cards.issueCard({
      activity,
      item,
      listing,
      mandate,
      settings,
      idempotencyKey: attemptKey,
    });
    if (attempt.cardId && attempt.cardId !== card.cardId) {
      throw new HttpError(502, "Card provider violated idempotency for this attempt.");
    }
    attempt.cardId = card.cardId;
    attempt.cardLast4 = card.last4;
    attempt.cardClaimedAt ??= new Date().toISOString();
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

  /** Live attempts allowed at once. Each is a separate browser and a separate card. */
  private get concurrency(): number {
    return Math.max(1, Number(process.env.PURCHASE_CONCURRENCY ?? 10));
  }

  private progressFor(run: PurchaseRun, itemId: string) {
    const existing = run.progress[itemId];
    if (existing) return existing;
    const fresh = { candidateIndex: 0, attemptIndex: 0, done: false };
    run.progress[itemId] = fresh;
    return fresh;
  }

  /**
   * Starts attempts for every shortlist item that needs one, up to the concurrency limit.
   *
   * Called after the purchase begins and again whenever an attempt ends, so a finished slot is
   * immediately refilled. Each item carries its own candidate and retry cursors, so one item
   * exhausting its alternates does not disturb the others.
   *
   * Failures to START are handled per item rather than aborting the run: one merchant refusing a
   * job should not cancel five other purchases that are working.
   */
  private async startAttempts(activityId: string): Promise<void> {
    const [activity, run] = await Promise.all([
      this.getActivity(activityId),
      this.repository.getPurchaseRun(activityId),
    ]);
    if (run?.status !== "running" || activity.status !== "live") return;

    const [mandate, settings] = await Promise.all([
      this.repository.getMandate(activity.userId),
      this.repository.getSettings(activity.userId),
    ]);

    const inFlight = new Set(Object.values(run.attempts).map((a) => a.itemId));
    const starts: Promise<void>[] = [];

    for (const pick of activity.shortlist) {
      if (Object.keys(run.attempts).length + starts.length >= this.concurrency) break;
      const progress = this.progressFor(run, pick.itemId);
      if (progress.done || inFlight.has(pick.itemId)) continue;

      const item = activity.wishlist.find((row) => row.id === pick.itemId);
      if (!item) continue;

      const listing = this.nextCandidate(activity, run, pick, item, mandate);
      if (!listing) continue;

      const attemptId = newId("attempt");
      const grantToken = `card-grant-${crypto.randomUUID()}`;
      const grantExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const attempt: PurchaseAttempt = {
        attemptId,
        itemId: pick.itemId,
        candidateIndex: progress.candidateIndex,
        attemptIndex: progress.attemptIndex,
        cardGrantHash: hashGrant(grantToken),
        cardGrantExpiresAt: grantExpiresAt,
      };
      // Recorded BEFORE dispatch. The Closer can call back the instant it accepts, and a callback
      // for an attempt this run has never heard of is rejected as stale.
      run.attempts[attemptId] = attempt;
      run.updatedAt = new Date().toISOString();
      inFlight.add(pick.itemId);

      starts.push(
        this.dispatchAttempt(activity, run, attempt, item, listing, grantToken, grantExpiresAt, settings.sandbox),
      );
    }

    await this.repository.putPurchaseRun(run);
    // Concurrently: N cold browser starts one after another is the slow path this exists to avoid.
    await Promise.allSettled(starts);
    await this.repository.putPurchaseRun(run);
    await this.completeIfDone(activity, run);
  }

  /** The next candidate listing for an item, skipping any the mandate or the amount rules out. */
  private nextCandidate(
    activity: Activity,
    run: PurchaseRun,
    pick: Activity["shortlist"][number],
    item: WishlistItem,
    mandate: Mandate,
  ): Listing | null {
    const progress = this.progressFor(run, pick.itemId);
    const candidates = [pick.listing, ...(pick.alternates ?? [])];

    while (progress.candidateIndex < candidates.length) {
      if (progress.attemptIndex >= this.config.PAYMENT_ATTEMPTS_PER_LISTING) {
        progress.candidateIndex += 1;
        progress.attemptIndex = 0;
        continue;
      }
      const listing = candidates[progress.candidateIndex];
      if (!listing) break;
      if (listing.amountMinor > pick.listing.amountMinor) {
        void this.appendSystemLog(
          activity,
          item,
          `skipped ${listing.title} · ${listing.price} exceeds the approved amount`,
        );
        progress.candidateIndex += 1;
        progress.attemptIndex = 0;
        continue;
      }
      try {
        this.assertListing(item, listing, mandate);
        return listing;
      } catch (error) {
        void this.appendSystemLog(activity, item, `skipped candidate · ${asMessage(error)}`);
        progress.candidateIndex += 1;
        progress.attemptIndex = 0;
      }
    }

    // Out of candidates. The item is finished — unsuccessfully — and must not block the others.
    progress.done = true;
    void this.appendSystemLog(activity, item, "every compliant candidate failed");
    return null;
  }

  private async dispatchAttempt(
    activity: Activity,
    run: PurchaseRun,
    attempt: PurchaseAttempt,
    item: WishlistItem,
    listing: Listing,
    grantToken: string,
    grantExpiresAt: string,
    sandbox: boolean,
  ): Promise<void> {
    const attemptKey = `${run.idempotencyKey}:${item.id}:${attempt.candidateIndex}:${attempt.attemptIndex}`;
    try {
      await this.purchaseAgents.startPurchase({
        activityId: activity.id,
        attemptId: attempt.attemptId,
        item,
        listing,
        cardGrant: {
          claimUrl: `${this.config.PUBLIC_BASE_URL.replace(/\/$/, "")}/v1/integrations/purchases/${encodeURIComponent(activity.id)}/attempts/${encodeURIComponent(attempt.attemptId)}/card`,
          token: grantToken,
          amountMinor: listing.amountMinor,
          currency: "SGD",
          expiresAt: grantExpiresAt,
        },
        sandbox,
        idempotencyKey: attemptKey,
      });
    } catch (error) {
      // One item failing to start must not take the others down with it.
      await this.expireAttemptCard(run, attempt);
      await this.appendSystemLog(
        activity,
        item,
        `could not start Closer attempt ${attempt.attemptIndex + 1} · ${asMessage(error)}`,
      );
      this.progressFor(run, item.id).attemptIndex += 1;
      this.clearAttempt(run, attempt.attemptId);
    }
  }

  /** Marks the run finished once every item has either been bought or run out of candidates. */
  private async completeIfDone(activity: Activity, run: PurchaseRun): Promise<void> {
    if (run.status !== "running") return;
    if (Object.keys(run.attempts).length > 0) return;
    const unfinished = activity.shortlist.filter((pick) => !this.progressFor(run, pick.itemId).done);
    if (unfinished.length > 0) return;

    run.status = "completed";
    run.updatedAt = new Date().toISOString();
    const purchasedIds = new Set(
      activity.execution.filter((row) => row.state === "purchased").map((row) => row.itemId),
    );
    const bought = activity.shortlist.filter((pick) => purchasedIds.has(pick.itemId));
    const completedAt = displayTime();
    activity.status = "completed";
    activity.completedAt = completedAt;
    activity.displayTs = completedAt;
    activity.totalMinor = bought.reduce((sum, row) => sum + row.listing.amountMinor, 0);
    activity.archiveLines = bought.map((row) => ({
      name:
        activity.wishlist.find((wishlistItem) => wishlistItem.id === row.itemId)?.name ?? row.itemId,
      seller: row.listing.seller,
      price: row.listing.price,
    }));
    await Promise.all([
      this.repository.putActivity(activity, "purchase.completed"),
      this.repository.putPurchaseRun(run),
    ]);
    this.events.emit(activity.id, {
      type: "activity.completed",
      completedAt,
      totalMinor: activity.totalMinor,
    });
    this.snapshot(activity);
  }

  private async confirmOrder(
    activity: Activity,
    run: PurchaseRun,
    attempt: PurchaseAttempt,
    item: WishlistItem,
    orderId: string,
    message?: string,
  ): Promise<void> {
    const [persistedActivity, persistedRun] = await Promise.all([
      this.repository.getActivity(activity.id),
      this.repository.getPurchaseRun(activity.id),
    ]);
    if (persistedActivity?.status !== "live" || persistedRun?.status !== "running") {
      throw new HttpError(409, "This order confirmation arrived after cancellation.");
    }
    const pick = activity.shortlist.find((row) => row.itemId === attempt.itemId);
    if (!pick) throw new Error("Confirmed item is outside the shortlist.");
    const listing = [pick.listing, ...(pick.alternates ?? [])][attempt.candidateIndex];
    if (!listing) throw new Error("Confirmed listing is outside the candidate list.");
    // The card belongs to this attempt, not to the run: with several in flight, reading a shared
    // field here would debit the wallet against whichever attempt happened to claim last.
    if (!attempt.cardId || !attempt.cardLast4 || !attempt.cardClaimedAt) {
      throw new HttpError(409, "Closer cannot confirm an order before claiming its card.");
    }
    const wallet = await this.repository.getWallet(activity.userId);
    const walletCard = wallet.cards.find(
      (row) => row.pan.endsWith(attempt.cardLast4 ?? "") && row.status === "issued",
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
    pick.reSearched = attempt.candidateIndex > 0;
    await this.repository.putWallet(activity.userId, wallet);
    await this.emitStep(
      activity,
      item,
      4,
      "purchased",
      message ? `${message} · order #${orderId}` : `order #${orderId} confirmed · card used`,
    );
    this.events.emit(activity.id, { type: "wallet.updated", wallet });

    this.progressFor(run, attempt.itemId).done = true;
    this.clearAttempt(run, attempt.attemptId);
    await this.repository.putPurchaseRun(run);
    // Refill the freed slot, then finish the run if that was the last item.
    void this.startAttempts(activity.id).catch((error) => this.failRun(activity.id, error));
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

  /** Marks this attempt's card spent-or-dead in the wallet. Never touches another attempt's. */
  private async expireAttemptCard(run: PurchaseRun, attempt: PurchaseAttempt): Promise<void> {
    if (!attempt.cardLast4) return;
    const wallet = await this.repository.getWallet(run.userId);
    const card = wallet.cards.find(
      (row) => row.pan.endsWith(attempt.cardLast4 ?? "") && row.status === "issued",
    );
    if (card) card.status = "expired";
    await this.repository.putWallet(run.userId, wallet);
    this.events.emit(run.activityId, { type: "wallet.updated", wallet });
  }

  private clearAttempt(run: PurchaseRun, attemptId: string): void {
    delete run.attempts[attemptId];
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
    await this.repository.putActivity(activity, "purchase.step_updated");
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
    await this.repository.putActivity(activity, "purchase.log_appended");
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
    // Every live attempt's card, not just one: a run that dies with five browsers open would
    // otherwise leave four cards marked issued forever.
    for (const attempt of Object.values(run.attempts)) {
      await this.expireAttemptCard(run, attempt);
    }
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
    await Promise.all([
      this.repository.putActivity(activity, "purchase.failed"),
      this.repository.putPurchaseRun(run),
    ]);
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
