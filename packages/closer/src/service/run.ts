import type { Page } from "playwright";
import type { BrowserLike } from "../types.js";
import { type CardMaterial, claimCard, revealCard } from "./card.js";
import { eventIdFor, type PurchaseEvent, sendCallback } from "./callbacks.js";
import type { JobStore } from "./jobs.js";
import type { LiveView } from "./liveview.js";
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
  fetchImpl?: typeof fetch;
  liveUrlFor: (attemptId: string) => string;
  /** Opens the listing and gets to a page with card fields on it. */
  toPaymentPage?: (page: Page, job: PurchaseJobInput) => Promise<void>;
  fillCard: (page: Page, card: CardMaterial) => Promise<void>;
  readTotalMinor: (page: Page) => Promise<number>;
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

  try {
    const payloadProblem = verifyGrant(job);
    if (payloadProblem) throw new Error(payloadProblem);

    checkCancelled();
    const browser = await deps.browserFor();
    const page = await browser.newPage();
    await emit({
      type: "browser.started",
      liveStreamUrl: deps.liveUrlFor(attemptId),
      message: `opened ${job.listing.url ?? job.listing.title}`,
    });

    checkCancelled();
    if (deps.toPaymentPage) await deps.toPaymentPage(page, job);

    checkCancelled();
    // The merchant's OWN total, read from the page. Trusting the payload here would let a merchant
    // that nudged its price between shortlist and checkout charge whatever it liked.
    const totalMinor = await deps.readTotalMinor(page);
    const totalProblem = verifyMerchantTotal(totalMinor, job.listing.amountMinor);
    if (totalProblem) throw new Error(totalProblem);

    checkCancelled();
    if (!deps.jobs.claimCardOnce(idempotencyKey)) {
      throw new Error("card already claimed for this attempt");
    }

    // From here until after submit, nothing the browser renders may reach a viewer.
    deps.view.blank(attemptId, "card entry in progress");
    let orderRef: string | null = null;
    try {
      const claimed = await claimCard(job.cardGrant, deps.fetchImpl);
      const material = await revealCard(claimed.agentAccess, deps.fetchImpl);
      await deps.fillCard(page, material);
      await emit({ type: "checkout.prepared", message: `${job.listing.seller} checkout ready` });

      await emit({ type: "order.placing", message: `placing ${job.listing.price}` });
      orderRef = await deps.submit(page);
    } finally {
      deps.view.resume(attemptId);
    }

    // An unknown outcome is a failure. Money has already moved by now, so inventing a reference
    // marks a purchase done that may never have charged.
    if (!orderRef) throw new Error("checkout finished with no order reference");

    await emit({ type: "order.confirmed", orderId: orderRef, message: "merchant confirmed" });
    deps.jobs.setState(idempotencyKey, "done");
  } catch (error) {
    const cancelled = error instanceof Cancelled;
    deps.jobs.setState(idempotencyKey, cancelled ? "cancelled" : "failed");
    await emit({
      type: "purchase.failed",
      message: error instanceof Error ? error.message : "purchase failed",
      retryable: !cancelled,
    });
  } finally {
    deps.view.close(attemptId);
  }
}
