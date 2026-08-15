import type { Page } from "playwright";
import { appendAudit } from "./audit.js";
import type { Db } from "./db.js";
import type { IssuerAdapter } from "./issuer/types.js";

export type CheckoutDeps = { db: Db; issuer: IssuerAdapter };
export type CheckoutResult = {
  ok: boolean;
  orderRef?: string;
  error?: "FIELDS_NOT_FOUND" | "CARD_UNREADABLE" | "DECLINED" | "TIMEOUT";
};

const SELECTORS = {
  number: [
    'input[autocomplete="cc-number"]',
    'input[name*="card" i][name*="num" i]',
    'input[id*="cardnumber" i]',
    'input[name="cardNumber"]',
  ],
  expiry: ['input[autocomplete="cc-exp"]', 'input[name*="exp" i]', 'input[id*="exp" i]'],
  cvc: [
    'input[autocomplete="cc-csc"]',
    'input[name*="cvc" i]',
    'input[name*="cvv" i]',
    'input[id*="cvc" i]',
  ],
  name: ['input[autocomplete="cc-name"]', 'input[name*="cardholder" i]', 'input[name="name"]'],
};

async function fillFirst(page: Page, candidates: string[], value: string): Promise<boolean> {
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.fill(value);
      return true;
    }
  }
  return false;
}

export async function payWithCard(
  deps: CheckoutDeps,
  page: Page,
  purchaseId: string,
): Promise<CheckoutResult> {
  const card = deps.db.raw
    .prepare(`SELECT * FROM cards WHERE purchase_id=?`)
    .get(purchaseId) as any;
  if (!card) return { ok: false, error: "CARD_UNREADABLE" };

  let material;
  try {
    material = await deps.issuer.reveal(card.opaque_id);
  } catch {
    appendAudit(deps.db, { purchaseId, kind: "CARD_UNREADABLE", detail: {} });
    return { ok: false, error: "CARD_UNREADABLE" };
  }

  const okNumber = await fillFirst(page, SELECTORS.number, material.pan);
  if (!okNumber) return { ok: false, error: "FIELDS_NOT_FOUND" };
  await fillFirst(page, SELECTORS.expiry, material.expiry);
  await fillFirst(page, SELECTORS.cvc, material.cvc);
  await fillFirst(page, SELECTORS.name, "Happy Agent");
  material = undefined as any; // drop the reference as soon as the fields are filled

  try {
    // waitForLoadState inspects the CURRENT page, which is already loaded, so racing it against
    // the click resolves instantly and we would read the pre-submit DOM. Wait for the navigation
    // the submit causes instead.
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load", timeout: 20_000 }),
      page.locator('button[type="submit"], input[type="submit"]').first().click(),
    ]);
  } catch {
    return { ok: false, error: "TIMEOUT" };
  }

  // Short timeout: the element is either on the settled page or it is not. Playwright's
  // 30s default would blow the test budget on every failure path.
  const ref = await page
    .locator("[data-order-ref]")
    .first()
    .getAttribute("data-order-ref", { timeout: 2_000 })
    .catch(() => null);
  if (ref) {
    appendAudit(deps.db, { purchaseId, kind: "CHECKOUT_OK", detail: { orderRef: ref } });
    return { ok: true, orderRef: ref };
  }

  const body = (await page.content()).toLowerCase();
  if (body.includes("declin")) {
    appendAudit(deps.db, { purchaseId, kind: "DECLINED", detail: {} });
    return { ok: false, error: "DECLINED" };
  }

  // No order reference and no decline: we do not know what happened. Reporting success here
  // would have the caller mark the purchase DONE against a page that may never have charged.
  // An unknown outcome is a failure.
  appendAudit(deps.db, { purchaseId, kind: "CHECKOUT_UNKNOWN", detail: { url: page.url() } });
  return { ok: false, error: "TIMEOUT" };
}
