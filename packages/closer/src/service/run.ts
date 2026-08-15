import type { Page } from "playwright";
import type { BrowserLike } from "../types.js";
import { fillAddressInto } from "./address.js";
import { type CardMaterial, claimCard, revealCard } from "./card.js";
import { eventIdFor, type PurchaseEvent, sendCallback } from "./callbacks.js";
import type { JobStore } from "./jobs.js";
import type { LiveView } from "./liveview.js";
import { type RunLog, runLogger } from "./log.js";
import { isSameSite } from "./navigator.js";
import { type PurchaseJobInput, verifyGrant, verifyMerchantTotal } from "./verify.js";

/**
 * One purchase, start to finish.
 *
 * The ordering IS the design. Everything that can fail for free happens before the card is
 * claimed; everything after it holds something with about ten minutes to live that dies on its
 * first authorisation. The live view is blanked across the whole window in which card material
 * exists.
 */
export type RunDeps = {
  jobs: JobStore;
  view: LiveView;
  browserFor: () => Promise<BrowserLike>;
  /**
   * Releases the browser when the run ends, however it ends.
   *
   * An AgentCore session bills until it is stopped, and its TTL is half an hour. Without this every
   * run — including every fast failure — leaves one running: three dead runs left three sessions
   * billing before this was noticed.
   */
  releaseBrowser?: (browser: BrowserLike) => Promise<void>;
  fetchImpl?: typeof fetch;
  liveUrlFor: (attemptId: string) => string;
  /** Opens the listing and gets to a page with card fields on it. */
  toPaymentPage?: (page: Page, job: PurchaseJobInput) => Promise<void>;
  /** Starts streaming the page into the live view. Returns a stop function. */
  attachFrames?: (page: Page, attemptId: string) => Promise<() => Promise<void>>;
  fillCard: (page: Page, card: CardMaterial) => Promise<void>;
  /** Fills the delivery address. Defaults to the real one; tests pass a stub. */
  fillAddress?: (page: Page, address: NonNullable<PurchaseJobInput["shippingAddress"]>) => Promise<string[]>;
  readTotalMinor: (page: Page) => Promise<number>;
  /** Overrides the default logger. Tests pass a sink to keep output quiet. */
  log?: RunLog;
  /** Submits and returns an order reference, or null when the outcome is unknown. */
  submit: (page: Page) => Promise<string | null>;
};

class Cancelled extends Error {}

export async function runPurchase(deps: RunDeps, job: PurchaseJobInput): Promise<void> {
  const { attemptId, idempotencyKey } = job;
  const base = { attemptId, itemId: job.item.id };

  const emit = async (event: PurchaseEvent) => {
    const seq = deps.jobs.nextSeq(idempotencyKey);
    await sendCallback(
      job.callback,
      { ...base, eventId: eventIdFor(attemptId, event.type, seq) },
      event,
      deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
    );
  };

  const checkCancelled = () => {
    if (deps.jobs.isCancelled(attemptId)) throw new Cancelled("attempt cancelled");
  };

  deps.jobs.setState(idempotencyKey, "running");
  let stopFrames: (() => Promise<void>) | null = null;
  let browser: BrowserLike | null = null;
  const log = deps.log ?? runLogger(attemptId);

  try {
    log("run started", { item: job.item.name, price: job.listing.price });
    const payloadProblem = verifyGrant(job);
    if (payloadProblem) throw new Error(payloadProblem);
    log("payload verified");

    checkCancelled();
    browser = await deps.browserFor();
    const page = await browser.newPage();
    log("browser open");
    // Started before browser.started is emitted, so the frontend has frames waiting the moment it
    // opens the URL that event carries.
    if (deps.attachFrames) {
      stopFrames = await deps.attachFrames(page, attemptId).catch((e) => {
        log("screencast failed to attach", { error: (e as Error).message });
        return null;
      });
      log("screencast attached", { streaming: stopFrames !== null });
    }
    await emit({
      type: "browser.started",
      liveStreamUrl: deps.liveUrlFor(attemptId),
      message: `opened ${job.listing.url ?? job.listing.title}`,
    });

    checkCancelled();
    if (deps.toPaymentPage) {
      log("navigating to payment page", { url: job.listing.url ?? "" });
      await deps.toPaymentPage(page, job);
      log("reached payment page", { at: page.url() });
    }

    checkCancelled();
    /*
     * Address first, card last. Everything before the claim is free to fail and retry; the same
     * failure after issuance strands a card that is already alive and single-use.
     */
    if (job.shippingAddress) {
      const fill = deps.fillAddress ?? fillAddressInto;
      const filled = await fill(page, job.shippingAddress).catch(() => [] as string[]);
      log("delivery address filled", { fields: filled.join(",") || "none" });
    }

    checkCancelled();
    // The merchant's OWN total, read from the page. Trusting the payload here would let a merchant
    // that nudged its price between shortlist and checkout charge whatever it liked.
    const totalMinor = await deps.readTotalMinor(page);
    log("merchant total read", { displayed: totalMinor, approved: job.listing.amountMinor });
    const totalProblem = verifyMerchantTotal(totalMinor, job.listing.amountMinor);
    if (totalProblem) throw new Error(totalProblem);

    checkCancelled();
    if (!deps.jobs.claimCardOnce(idempotencyKey)) {
      throw new Error("card already claimed for this attempt");
    }
    log("card claim reserved — blanking live view");

    // From here until after submit, nothing the browser renders may reach a viewer.
    deps.view.blank(attemptId, "card entry in progress");
    let orderRef: string | null = null;
    try {
      const claimed = await claimCard(job.cardGrant, deps.fetchImpl);
      // last4 only. Never the pan, expiry or cvc — a log line is a card leak.
      log("card claimed", { last4: claimed.last4 });
      const material = await revealCard(claimed.agentAccess, deps.fetchImpl);

      /*
       * The last line of defence, checked with the card in hand and about to be typed.
       *
       * Everything between opening the listing and here can navigate: a model choosing links, a
       * merchant redirect, a page that rewrites itself. If any of that has landed us somewhere
       * other than the approved shop, the next statement types a real card number into whoever is
       * on the other end. Cheap to check, unrecoverable to skip.
       */
      const approvedHost = new URL(job.listing.url ?? "").hostname;
      if (!isSameSite(page.url(), approvedHost)) {
        throw new Error(
          `refusing to enter card details on ${new URL(page.url()).hostname}, which is not ${approvedHost}`,
        );
      }

      log("card revealed, typing into checkout", { host: approvedHost });
      await deps.fillCard(page, material);
      log("card fields filled");
      await emit({ type: "checkout.prepared", message: `${job.listing.seller} checkout ready` });

      await emit({ type: "order.placing", message: `placing ${job.listing.price}` });
      log("submitting");
      orderRef = await deps.submit(page);
      log("submit returned", { orderRef: orderRef ?? "none" });
    } finally {
      deps.view.resume(attemptId);
    }

    // An unknown outcome is a failure. Money has already moved by now, so inventing a reference
    // marks a purchase done that may never have charged.
    if (!orderRef) throw new Error("checkout finished with no order reference");

    await emit({ type: "order.confirmed", orderId: orderRef, message: "merchant confirmed" });
    log("DONE", { orderRef });
    deps.jobs.setState(idempotencyKey, "done");
  } catch (error) {
    const cancelled = error instanceof Cancelled;
    log(cancelled ? "CANCELLED" : "FAILED", {
      reason: error instanceof Error ? error.message : String(error),
    });
    deps.jobs.setState(idempotencyKey, cancelled ? "cancelled" : "failed");
    await emit({
      type: "purchase.failed",
      message: error instanceof Error ? error.message : "purchase failed",
      retryable: !cancelled,
    });
  } finally {
    if (stopFrames) await stopFrames().catch(() => {});
    deps.view.close(attemptId);
    // Last, and unconditional: a browser left open bills until its TTL expires.
    if (browser && deps.releaseBrowser) {
      await deps.releaseBrowser(browser).catch((e) =>
        log("browser release failed", { error: (e as Error).message }),
      );
      log("browser released");
    }
  }
}
