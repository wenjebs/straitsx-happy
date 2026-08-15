import type { Page } from "playwright";
import type { BrowserLike, CheckoutOptions, MerchantAdapter, PayApi } from "../src/types.js";

export type FakePay = PayApi & {
  calls: string[];
  states: Map<string, string>;
  /** What the runner passed as payWithCard's third argument, per call. */
  checkoutOpts: CheckoutOptions[];
};

/** A PayApi that records its call order and tracks purchase state the way the real ledger does. */
export function fakePay(over: Partial<PayApi> = {}): FakePay {
  const calls: string[] = [];
  const states = new Map<string, string>();
  const checkoutOpts: CheckoutOptions[] = [];
  let n = 0;
  const base: PayApi = {
    async getMandate() {
      calls.push("getMandate");
      return {
        perItemCents: 3000,
        dailyCents: 15000,
        remainingCents: 15000,
        limits: { minCardCents: 500, maxCardCents: 3000 },
      };
    },
    async evaluate() {
      calls.push("evaluate");
      return { decision: "ALLOW" };
    },
    async reserve() {
      n += 1;
      const id = `pur_${n}`;
      calls.push(`reserve:${id}`);
      states.set(id, "RESERVED");
      return { id };
    },
    async issueCard(id) {
      calls.push(`issueCard:${id}`);
      states.set(id, "CARD_ISSUED");
      return { last4: "4402", expiresAt: null, settlementTx: null };
    },
    async payWithCard(_page, _id, opts) {
      calls.push("payWithCard");
      checkoutOpts.push(opts ?? {});
      return { ok: true, orderRef: "ord_a1b2" };
    },
    async complete(id) {
      calls.push(`complete:${id}`);
      states.set(id, "DONE");
    },
    async cancel(id) {
      calls.push(`cancel:${id}`);
      states.set(id, states.get(id) === "CARD_ISSUED" ? "STRANDED" : "RELEASED");
    },
    async getPurchase(id) {
      const state = states.get(id);
      return state ? { state } : null;
    },
  };
  return Object.assign(base, over, { calls, states, checkoutOpts });
}

export function fakePage(url = "http://127.0.0.1:4033/checkout?sku=nvme-ssd") {
  return { url: () => url, goto: async () => null, close: async () => {} } as unknown as Page;
}

export function fakeBrowser(page: Page = fakePage()): BrowserLike {
  return { newPage: async () => page };
}

export function fakeAdapter(
  totalCents = 2900,
  over: Partial<MerchantAdapter> = {},
): MerchantAdapter {
  return {
    name: "fake",
    matches: () => true,
    async toPaymentPage() {},
    async readFinalTotalCents() {
      return totalCents;
    },
    ...over,
  };
}
