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

export type CheckoutOptions = {
  /**
   * Merchant-specific confirmation, consulted ONLY when the built-in check finds no
   * `[data-order-ref]`. Return the real order reference, or null if you cannot prove the order
   * landed. Returning a fabricated string marks a purchase DONE that may never have charged.
   *
   * Without this, a successful order at any merchant that does not use `[data-order-ref]` — i.e.
   * every real one — comes back as TIMEOUT, and a caller that cancels on failure strands money
   * that actually bought something.
   */
  confirm?: (page: Page) => Promise<string | null>;
  /** Overrides submit-button discovery. Use when the checkout's markup defeats the default. */
  submitSelector?: string;
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

/** Returns the selector that matched, so the caller can scope later queries to the same form. */
async function fillFirst(page: Page, candidates: string[], value: string): Promise<string | null> {
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.fill(value);
      return sel;
    }
  }
  return null;
}

/**
 * Prefers the submit control inside the form holding the card number. A real checkout page
 * routinely carries other forms — newsletter signup, coupon codes, search — and clicking the
 * page's first submit button can fire one of those instead of paying.
 */
async function submitLocator(page: Page, numberSelector: string, override?: string) {
  if (override) return page.locator(override).first();
  const scoped = page.locator(
    `form:has(${numberSelector}) button[type="submit"], form:has(${numberSelector}) input[type="submit"]`,
  );
  if ((await scoped.count()) > 0) return scoped.first();
  return page.locator('button[type="submit"], input[type="submit"]').first();
}

export async function payWithCard(
  deps: CheckoutDeps,
  page: Page,
  purchaseId: string,
  opts: CheckoutOptions = {},
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

  const numberSelector = await fillFirst(page, SELECTORS.number, material.pan);
  if (!numberSelector) return { ok: false, error: "FIELDS_NOT_FOUND" };
  await fillFirst(page, SELECTORS.expiry, material.expiry);
  await fillFirst(page, SELECTORS.cvc, material.cvc);
  await fillFirst(page, SELECTORS.name, "Happy Agent");
  material = undefined as any; // drop the reference as soon as the fields are filled

  try {
    // waitForLoadState inspects the CURRENT page, which is already loaded, so racing it against
    // the click resolves instantly and we would read the pre-submit DOM. Wait for the navigation
    // the submit causes instead.
    const submit = await submitLocator(page, numberSelector, opts.submitSelector);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load", timeout: 20_000 }),
      submit.click(),
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

  // Declines are settled BEFORE any caller strategy runs. A confirm() loose enough to match
  // "we could not process your order" would otherwise mark a purchase DONE that never charged —
  // reporting goods that do not exist, which is worse than reporting a failure that succeeded.
  // The library owns this precedence so a single sloppy adapter cannot invert it.
  const body = (await page.content()).toLowerCase();
  if (body.includes("declin")) {
    appendAudit(deps.db, { purchaseId, kind: "DECLINED", detail: {} });
    return { ok: false, error: "DECLINED" };
  }

  // The built-in check is demo-store shaped. Real merchants need a caller-supplied strategy;
  // it may only CONFIRM an order, never invent one.
  if (opts.confirm) {
    const confirmed = await opts.confirm(page).catch(() => null);
    if (confirmed) {
      appendAudit(deps.db, { purchaseId, kind: "CHECKOUT_OK", detail: { orderRef: confirmed } });
      return { ok: true, orderRef: confirmed };
    }
  }

  // No order reference and no decline: we do not know what happened. Reporting success here
  // would have the caller mark the purchase DONE against a page that may never have charged.
  // An unknown outcome is a failure.
  appendAudit(deps.db, { purchaseId, kind: "CHECKOUT_UNKNOWN", detail: { url: page.url() } });
  return { ok: false, error: "TIMEOUT" };
}
