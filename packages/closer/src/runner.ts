import { demoStoreAdapter } from "./adapters/demo-store.js";
import { makeLogger, mask, sgd } from "./format.js";
import {
  createFileJournal,
  type Journal,
  type JournalItem,
  type JournalRecord,
} from "./journal.js";
import { realPay } from "./pay-api.js";
import type {
  BrowserLike,
  CheckoutOptions,
  CloserEvent,
  ItemOutcome,
  MerchantAdapter,
  PayApi,
  PurchaseRequest,
  RunResult,
  Selection,
  ShippingProfile,
} from "./types.js";

/** The adapter's per-merchant knowledge, handed to @happy/pay. The library owns the safety rules —
 *  confirm() may confirm an order but never invent one, and an explicit decline wins outright — so
 *  they live in one place rather than in every adapter. */
function checkoutOptsFor(a: MerchantAdapter): CheckoutOptions {
  const confirm = a.confirmOrder?.bind(a);
  return {
    ...(confirm ? { confirm } : {}),
    ...(a.submitSelector ? { submitSelector: a.submitSelector } : {}),
  };
}

const reasonText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mandateReason = (e: unknown) =>
  e && typeof e === "object" && "reason" in e ? String((e as { reason: unknown }).reason) : null;

export type CloserDeps = {
  browser: BrowserLike;
  onEvent: (e: CloserEvent) => void;
  pay?: PayApi;
  adapters?: MerchantAdapter[];
  journal?: Journal;
  shipping?: ShippingProfile;
  /** Milliseconds allowed for everything before issuance, per item. */
  preIssueBudgetMs?: number;
  now?: () => number;
};

const DEFAULT_SHIPPING: ShippingProfile = {
  name: "Happy Agent",
  email: "agent@happy.local",
  addressLine: "1 Marina Boulevard",
  postalCode: "018989",
  phone: "+6580000000",
};

export function createCloser(deps: CloserDeps) {
  const pay = deps.pay ?? realPay;
  const adapters = deps.adapters ?? [demoStoreAdapter];
  const journal = deps.journal ?? createFileJournal();
  const shipping = deps.shipping ?? DEFAULT_SHIPPING;
  const now = deps.now ?? (() => Date.now());
  const preIssueBudgetMs = deps.preIssueBudgetMs ?? 90_000;

  async function run(req: PurchaseRequest): Promise<RunResult> {
    const startedAt = new Date(now()).toISOString();
    const rec: JournalRecord = {
      activityId: req.activityId,
      idempotencyKey: req.idempotencyKey,
      startedAt,
      state: "running",
      items: [],
      result: null,
    };
    journal.write(rec);

    const log = makeLogger(req.activityId, deps.onEvent, now);
    const items: ItemOutcome[] = [];

    // Strictly sequential: the contract requires it (§6) and so does the rail — the shared rate
    // limit is roughly a dozen POSTs for the whole venue.
    for (const [i, sel] of req.selections.entries()) {
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 0, state: "queued" } });
      items.push(
        await buyOne(sel, sel.tag ?? sel.itemId.toUpperCase(), sel.hueIndex ?? i % 6, log, rec),
      );
    }

    const totalMinor = items
      .filter((o) => o.status === "purchased" || o.status === "stranded")
      .reduce((sum, o) => sum + (o.amountMinor ?? 0), 0);
    const result: RunResult = {
      activityId: req.activityId,
      idempotencyKey: req.idempotencyKey,
      items,
      totalMinor,
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      aborted: false,
    };
    rec.state = "finished";
    rec.result = result;
    journal.write(rec);
    deps.onEvent({ type: "wallet.dirty" });
    deps.onEvent({ type: "run.completed", completedAt: result.finishedAt, totalMinor });
    return result;
  }

  async function buyOne(
    sel: Selection,
    tag: string,
    hue: number,
    log: (tag: string, hue: number, text: string) => void,
    rec: JournalRecord,
  ): Promise<ItemOutcome> {
    const url = new URL(sel.url);
    const adapter = adapters.find((a) => a.matches(url));
    const item: JournalItem = { itemId: sel.itemId, state: "skipped" };
    rec.items.push(item);
    journal.write(rec);

    const skip = (reason: string, text: string): ItemOutcome => {
      item.state = "skipped";
      item.reason = reason;
      journal.write(rec);
      log("SYS", hue, text);
      return { itemId: sel.itemId, status: "skipped", reason };
    };

    if (!adapter)
      return skip("NO_ADAPTER", `${sel.itemId} skipped · no adapter for ${url.hostname}`);

    const deadlineAt = now() + preIssueBudgetMs;
    const page = await deps.browser.newPage();
    try {
      // --- Z1: navigate and read the real total. Everything here is free to fail. -------------
      const ctx = { shipping, log: (t: string) => log(tag, hue, t), deadlineAt };
      const reach = async () => {
        await page.goto(sel.url, { waitUntil: "load", timeout: 20_000 });
        await adapter.toPaymentPage(page, ctx);
        return adapter.readFinalTotalCents(page);
      };
      let total: number;
      try {
        total = await reach();
      } catch {
        // One retry, here and nowhere else. Before issuance a retry costs nothing; after it, a
        // retry is only ever @happy/pay replaying its own stored envelope (invariants 2 and 3).
        try {
          total = await reach();
        } catch (err) {
          return skip("PRECHECK_FAILED", `${sel.itemId} skipped · ${reasonText(err)}`);
        }
      }
      if (!Number.isInteger(total) || total <= 0)
        return skip("TOTAL_UNREADABLE", `${sel.itemId} skipped · could not read a total`);
      if (now() > deadlineAt)
        return skip("TIMEOUT_PRE_ISSUE", `${sel.itemId} skipped · took too long before issuing`);

      const here = new URL(page.url());
      // The merchant host comes from the URL, never from page content. Spec §12.
      const merchantHost = here.hostname.toLowerCase();
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 1, state: "live" } });
      log(tag, hue, `${merchantHost}${here.pathname} · total ${sgd(total)}`);

      // --- Z2: the mandate decides. Still no money moved. -------------------------------------
      const m = await pay.getMandate();
      if (!m) return skip("MANDATE_INACTIVE", `${sel.itemId} skipped · no active mandate`);
      if (total < m.limits.minCardCents)
        return skip(
          "BELOW_RAIL_MINIMUM",
          `${sel.itemId} skipped · ${sgd(total)} is under the ${sgd(m.limits.minCardCents)} card floor`,
        );
      if (total > m.limits.maxCardCents)
        return skip(
          "ABOVE_RAIL_MAXIMUM",
          `${sel.itemId} skipped · ${sgd(total)} is over the ${sgd(m.limits.maxCardCents)} card ceiling`,
        );

      const quote = {
        amountCents: total,
        merchantHost,
        itemName: sel.itemName ?? sel.itemId,
        productUrl: sel.url,
      };
      const d = await pay.evaluate(quote);
      if (d.decision === "NEEDS_HUMAN")
        // No endpoint in BACKEND_CONTRACT.md can call approve(), and the run is unattended.
        return skip(
          "NEEDS_HUMAN",
          `${sel.itemId} skipped · ${sgd(total)} needs a human (${d.reason})`,
        );
      if (d.decision === "DENY")
        return skip(d.reason, `${sel.itemId} skipped · mandate says ${d.reason}`);

      item.state = "reserving";
      journal.write(rec);
      let purchase: { id: string };
      try {
        purchase = await pay.reserve(quote);
      } catch (err) {
        return skip(
          mandateReason(err) ?? "RESERVE_FAILED",
          `${sel.itemId} skipped · could not hold budget (${reasonText(err)})`,
        );
      }
      item.state = "reserved";
      item.purchaseId = purchase.id;
      item.amountMinor = total;
      journal.write(rec);

      // --- Z3: the last exit that costs nothing. ----------------------------------------------
      // Between the Z1 read and the mint there is a reserve round-trip and, on a real merchant,
      // often a shipping selection that rewrites the total. Re-reading turns "minted a card for
      // the wrong amount" into a free skip.
      const again = await adapter.readFinalTotalCents(page).catch(() => null);
      const ceiling = total + Math.floor((total * 200) / 10_000); // PRICE_TOLERANCE_BPS
      const bad =
        again === null ||
        !Number.isInteger(again) ||
        again > ceiling ||
        again < m.limits.minCardCents ||
        again > m.limits.maxCardCents;
      if (bad) {
        await pay.cancel(purchase.id, "price_changed"); // RESERVED → RELEASED; the last free exit
        return skip(
          "PRICE_CHANGED",
          `${sel.itemId} skipped · total moved to ${again === null ? "unreadable" : sgd(again)}`,
        );
      }
      const finalCents = again;

      // --- Z4: irreversible. The journal records the intent before the money moves. -----------
      item.state = "issuing";
      journal.write(rec);
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 2, state: "live" } });
      const card = await pay.issueCard(purchase.id, finalCents);
      log(tag, hue, `card ${mask(card.last4)} issued · limit ${sgd(finalCents)}`);

      // --- Z5/Z6: no way back. -----------------------------------------------------------------
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 3, state: "live" } });
      log(tag, hue, `${merchantHost}${here.pathname} · placing order ${sgd(finalCents)}`);
      const res = await pay.payWithCard(page, purchase.id, checkoutOptsFor(adapter));
      const orderRef = res.orderRef ?? null;
      await pay.complete(purchase.id, orderRef);
      item.state = "done";
      item.orderRef = orderRef;
      journal.write(rec);
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 4, state: "purchased" } });
      log(tag, hue, `order #${orderRef} confirmed · card spent`);
      return {
        itemId: sel.itemId,
        status: "purchased",
        purchaseId: purchase.id,
        orderRef,
        amountMinor: finalCents,
        last4: card.last4,
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return { run };
}
