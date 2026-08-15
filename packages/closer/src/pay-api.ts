import * as pay from "@happy/pay";
import type { PayApi } from "./types.js";

/** The real library, narrowed to what the Closer is allowed to call. Nothing here adds behaviour —
 *  it exists so tests can substitute a fake without the runner importing @happy/pay directly. */
export const realPay: PayApi = {
  getMandate: () => pay.getMandate(),
  evaluate: (q) => pay.evaluate(q),
  reserve: (q) => pay.reserve(q),
  issueCard: (id, cents) => pay.issueCard(id, cents),
  payWithCard: (page, id, opts) => pay.payWithCard(page, id, opts ?? {}),
  complete: (id, ref) => pay.complete(id, ref),
  cancel: (id, reason) => pay.cancel(id, reason),
  getPurchase: (id) => pay.getPurchase(id),
};
