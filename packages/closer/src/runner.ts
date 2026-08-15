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
  BrowserFor,
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
  /** One session for the whole run, or a function that returns the session for each shop. */
  browser: BrowserLike | BrowserFor;
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
  const inFlight = new Map<string, Promise<RunResult>>();

  /** The contract's rule (§6): the same key must never buy twice, on a rail with no refunds. */
  async function run(req: PurchaseRequest): Promise<RunResult> {
    // Order matters: a live run's journal also says "running", so the in-flight check comes first.
    const live = inFlight.get(req.activityId);
    if (live) return live;

    const prior = journal.read(req.activityId);
    if (prior && prior.idempotencyKey !== req.idempotencyKey)
      throw new Error(
        `this activity has already been purchased (key ${prior.idempotencyKey}) — there are no refunds on this rail`,
      );
    if (prior?.result) return prior.result;
    if (prior?.state === "running") {
      // A crash left a run unfinished. Replaying it could mint a second card for the same item.
      const stuck = prior.items.find((i) => i.state === "issuing" || i.state === "reserving");
      const state = stuck?.purchaseId ? (await pay.getPurchase(stuck.purchaseId))?.state : "unknown";
      throw new Error(
        `activity ${req.activityId} has an unfinished run — ${stuck?.itemId ?? "an item"} is ${state}; resolve it before re-running`,
      );
    }

    const p = execute(req).finally(() => inFlight.delete(req.activityId));
    inFlight.set(req.activityId, p);
    return p;
  }

  async function execute(req: PurchaseRequest): Promise<RunResult> {
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
    let aborted = false;
    for (const [i, sel] of req.selections.entries()) {
      const hue = sel.hueIndex ?? i % 6;
      if (aborted) {
        items.push({ itemId: sel.itemId, status: "skipped", reason: "RUN_ABORTED" });
        continue;
      }
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 0, state: "queued" } });
      let r: { outcome: ItemOutcome; abort?: boolean };
      try {
        r = await buyOne(sel, sel.tag ?? sel.itemId.toUpperCase(), hue, log, rec);
      } catch (err) {
        // buyOne only throws on a defect. Record it and stop: letting it escape would reject run()
        // with the journal still "running", which loses the record and blocks the activity forever.
        log("SYS", hue, `${sel.itemId} · runner error · ${reasonText(err)}`);
        r = {
          outcome: { itemId: sel.itemId, status: "unknown", reason: "RUNNER_ERROR" },
          abort: true,
        };
      }
      items.push(r.outcome);
      // An unknown settlement almost always means the rail is down, rate-limited or the wallet is
      // dry. Continuing would be safe for the ledger and pointless in practice.
      if (r.abort) aborted = true;
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
      aborted,
    };
    rec.state = aborted ? "aborted" : "finished";
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
  ): Promise<{ outcome: ItemOutcome; abort?: boolean }> {
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
      return { outcome: skip("NO_ADAPTER", `${sel.itemId} skipped · no adapter for ${url.hostname}`) };

    const deadlineAt = now() + preIssueBudgetMs;
    // The session is chosen by the shop's host, so a run can move between shops the user has
    // connected separately. One BrowserLike for everything still works, and is the default.
    const session =
      typeof deps.browser === "function" ? await deps.browser(url.hostname) : deps.browser;
    const page = await session.newPage();
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
          return { outcome: skip("PRECHECK_FAILED", `${sel.itemId} skipped · ${reasonText(err)}`) };
        }
      }
      if (!Number.isInteger(total) || total <= 0)
        return { outcome: skip("TOTAL_UNREADABLE", `${sel.itemId} skipped · could not read a total`) };
      if (now() > deadlineAt)
        return { outcome: skip("TIMEOUT_PRE_ISSUE", `${sel.itemId} skipped · took too long before issuing`) };

      const here = new URL(page.url());
      // The merchant host comes from the URL, never from page content. Spec §12.
      const merchantHost = here.hostname.toLowerCase();
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 1, state: "live" } });
      log(tag, hue, `${merchantHost}${here.pathname} · total ${sgd(total)}`);

      // --- Z2: the mandate decides. Still no money moved. -------------------------------------
      const m = await pay.getMandate();
      if (!m)
        return { outcome: skip("MANDATE_INACTIVE", `${sel.itemId} skipped · no active mandate`) };
      if (total < m.limits.minCardCents)
        return { outcome: skip(
          "BELOW_RAIL_MINIMUM",
          `${sel.itemId} skipped · ${sgd(total)} is under the ${sgd(m.limits.minCardCents)} card floor`,
        ) };
      if (total > m.limits.maxCardCents)
        return { outcome: skip(
          "ABOVE_RAIL_MAXIMUM",
          `${sel.itemId} skipped · ${sgd(total)} is over the ${sgd(m.limits.maxCardCents)} card ceiling`,
        ) };

      const quote = {
        amountCents: total,
        merchantHost,
        itemName: sel.itemName ?? sel.itemId,
        productUrl: sel.url,
      };
      const d = await pay.evaluate(quote);
      if (d.decision === "NEEDS_HUMAN")
        // No endpoint in BACKEND_CONTRACT.md can call approve(), and the run is unattended.
        return { outcome: skip(
          "NEEDS_HUMAN",
          `${sel.itemId} skipped · ${sgd(total)} needs a human (${d.reason})`,
        ) };
      if (d.decision === "DENY")
        return { outcome: skip(d.reason, `${sel.itemId} skipped · mandate says ${d.reason}`) };

      item.state = "reserving";
      journal.write(rec);
      let purchase: { id: string };
      try {
        purchase = await pay.reserve(quote);
      } catch (err) {
        return { outcome: skip(
          mandateReason(err) ?? "RESERVE_FAILED",
          `${sel.itemId} skipped · could not hold budget (${reasonText(err)})`,
        ) };
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
        return { outcome: skip(
          "PRICE_CHANGED",
          `${sel.itemId} skipped · total moved to ${again === null ? "unreadable" : sgd(again)}`,
        ) };
      }
      const finalCents = again;

      // --- Z4: irreversible. The journal records the intent before the money moves. -----------
      item.state = "issuing";
      journal.write(rec);
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 2, state: "live" } });

      let card: { last4: string | null; expiresAt: string | null; settlementTx: string | null };
      try {
        card = await pay.issueCard(purchase.id, finalCents);
      } catch (err) {
        // The error cannot tell us whether anything was sent. The ledger can.
        const state = (await pay.getPurchase(purchase.id))?.state;
        if (state === "RESERVED") {
          // markPaying() runs before send(), so nothing was transmitted.
          await pay.cancel(purchase.id, "issue_failed");
          return {
            outcome: skip(
              "ISSUE_REFUSED",
              `${sel.itemId} skipped · card not issued (${reasonText(err)})`,
            ),
          };
        }
        if (state === "PAYING") {
          // Invariant 4: nobody knows whether the money left. cancel() would throw, and calling it
          // would be a bug rather than a safety net. @happy/pay's reconciler owns this purchase.
          item.state = "unknown";
          journal.write(rec);
          log(
            "SYS",
            hue,
            `settlement outcome unknown · run stopped · reconciler will resolve ${purchase.id}`,
          );
          return {
            outcome: {
              itemId: sel.itemId,
              status: "unknown",
              reason: "SETTLEMENT_UNKNOWN",
              purchaseId: purchase.id,
              amountMinor: finalCents,
            },
            abort: true,
          };
        }
        if (state !== "CARD_ISSUED") throw err; // unreachable in pay's state machine; don't guess
        // A card exists and the money is gone. The only useful move is to go and get the goods.
        card = { last4: null, expiresAt: null, settlementTx: null };
      }
      log(tag, hue, `card ${mask(card.last4)} issued · limit ${sgd(finalCents)}`);

      // --- Z5/Z6: no way back. Either get the goods, or record the loss. -----------------------
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 3, state: "live" } });
      log(tag, hue, `${merchantHost}${here.pathname} · placing order ${sgd(finalCents)}`);
      let res: { ok: boolean; orderRef?: string; error?: string };
      try {
        res = await pay.payWithCard(page, purchase.id, checkoutOptsFor(adapter));
      } catch {
        res = { ok: false, error: "CHECKOUT_THREW" };
      }

      // An unknown outcome is a failure (invariant 8), and `ok` is the whole answer: the library
      // has already settled declines and refused to invent a reference.
      const orderRef = res.ok ? (res.orderRef ?? null) : null;
      if (!orderRef) {
        // No refunds exist (invariant 9). cancel() writes STRANDED and keeps the money on the
        // books. The Closer's job is to make that loud rather than to hide it.
        const reason = res.error ?? "CHECKOUT_FAILED";
        await pay.cancel(purchase.id, reason.toLowerCase());
        item.state = "stranded";
        journal.write(rec);
        log(
          "SYS",
          hue,
          `${sgd(finalCents)} spent · no order confirmation · card ${mask(card.last4)} stranded`,
        );
        return {
          outcome: {
            itemId: sel.itemId,
            status: "stranded",
            reason,
            purchaseId: purchase.id,
            amountMinor: finalCents,
            last4: card.last4,
          },
        };
      }

      await pay.complete(purchase.id, orderRef);
      item.state = "done";
      item.orderRef = orderRef;
      journal.write(rec);
      deps.onEvent({ type: "exec.step", row: { itemId: sel.itemId, step: 4, state: "purchased" } });
      log(tag, hue, `order #${orderRef} confirmed · card spent`);
      return {
        outcome: {
          itemId: sel.itemId,
          status: "purchased",
          purchaseId: purchase.id,
          orderRef,
          amountMinor: finalCents,
          last4: card.last4,
        },
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return { run };
}
