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
    const adapter = adapters.find((a) => a.matches(url)) as MerchantAdapter;
    const item: JournalItem = { itemId: sel.itemId, state: "reserving" };
    rec.items.push(item);
    journal.write(rec);

    const deadlineAt = now() + preIssueBudgetMs;
    const page = await deps.browser.newPage();
    try {
      // --- Z1: navigate and read the real total. Free to fail. -------------------------------
      await page.goto(sel.url, { waitUntil: "load", timeout: 20_000 });
      await adapter.toPaymentPage(page, { shipping, log: (t) => log(tag, hue, t), deadlineAt });
      const total = await adapter.readFinalTotalCents(page);
      const here = new URL(page.url());
      // The merchant host comes from the URL, never from page content. Spec §12.
      const merchantHost = here.hostname.toLowerCase();
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 1, state: "live" } });
      log(tag, hue, `${merchantHost}${here.pathname} · total ${sgd(total)}`);

      // --- Z2: hold the budget. Still no money moved. ------------------------------------------
      const quote = {
        amountCents: total,
        merchantHost,
        itemName: sel.itemName ?? sel.itemId,
        productUrl: sel.url,
      };
      await pay.getMandate();
      await pay.evaluate(quote);
      const purchase = await pay.reserve(quote);
      item.state = "reserved";
      item.purchaseId = purchase.id;
      item.amountMinor = total;
      journal.write(rec);

      // --- Z4: irreversible. The journal records the intent before the money moves. -----------
      item.state = "issuing";
      journal.write(rec);
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 2, state: "live" } });
      const card = await pay.issueCard(purchase.id, total);
      log(tag, hue, `card ${mask(card.last4)} issued · limit ${sgd(total)}`);

      // --- Z5/Z6: no way back. -----------------------------------------------------------------
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 3, state: "live" } });
      log(tag, hue, `${merchantHost}${here.pathname} · placing order ${sgd(total)}`);
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
        amountMinor: total,
        last4: card.last4,
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return { run };
}
