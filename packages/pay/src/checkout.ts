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

type FieldHit = { selector: string; sameDocument: boolean };

/** Per-keystroke delay. Tests set CARD_TYPE_DELAY_MS=0; real runs want human-ish timing. */
const typeDelayMs = () => {
  const override = process.env.CARD_TYPE_DELAY_MS;
  if (override !== undefined && override !== "") return Number(override);
  return 70 + Math.random() * 80;
};

/**
 * Fills the first matching field, searching the page and then every child frame.
 *
 * PCI DSS 4.0 pushes serious gateways to render the card number inside an iframe they control —
 * Shopify serves it from checkout.pci.shopifyinc.com — and Playwright's page-level locators do
 * not cross frame boundaries. Searching the page alone returns FIELDS_NOT_FOUND at essentially
 * every real merchant, so no purchase can ever happen. Verified live against a Shopify checkout:
 * the fields carry exactly our autocomplete selectors, one document down.
 *
 * Reports whether the hit was in the main document, because that decides whether the submit
 * button can be scoped to the same form (see submitLocator).
 */
async function fillFirst(
  page: Page,
  candidates: string[],
  value: string,
): Promise<FieldHit | null> {
  const children = page.frames().filter((f) => f !== page.mainFrame());
  for (const sel of candidates) {
    for (const [i, scope] of [page, ...children].entries()) {
      const el = scope.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        // Type it rather than fill() it. Setting sixteen digits instantly with no keystrokes is
        // a named fraud signal — gateways weight "copy-pasted rather than typed" heavily, and a
        // card they have never seen before is already the riskiest profile they score. Looking
        // automated does not just risk a decline, it invites the 3DS challenge that kills a
        // single-use card. Four seconds against a ten-minute TTL is a good trade.
        await el.click();
        await el.pressSequentially(value, { delay: typeDelayMs() });
        return { selector: sel, sameDocument: i === 0 };
      }
    }
  }
  return null;
}

/**
 * Finds the control that actually pays. A real checkout carries other forms — newsletter,
 * coupon, search — and clicking the page's first submit button can fire one of those instead.
 *
 * When the card field is in the main document we scope to its own form, which is exact. When it
 * is inside a gateway iframe the pay button lives in a different document, so that scoping
 * cannot match; we fall back to matching the button by its accessible name, which is what a
 * person reads to find it, and only then to the first submit on the page.
 */
async function submitLocator(page: Page, hit: FieldHit, override?: string) {
  if (override) return page.locator(override).first();

  if (hit.sameDocument) {
    const scoped = page.locator(
      `form:has(${hit.selector}) button[type="submit"], form:has(${hit.selector}) input[type="submit"]`,
    );
    if ((await scoped.count()) > 0) return scoped.first();
  }

  const byName = page
    .getByRole("button", { name: /pay now|place order|complete order|^pay\b|confirm order/i })
    .first();
  if ((await byName.count()) > 0) return byName;

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

  const numberHit = await fillFirst(page, SELECTORS.number, material.pan);
  if (!numberHit) return { ok: false, error: "FIELDS_NOT_FOUND" };
  await fillFirst(page, SELECTORS.expiry, material.expiry);
  await fillFirst(page, SELECTORS.cvc, material.cvc);
  await fillFirst(page, SELECTORS.name, "Happy Agent");
  material = undefined as any; // drop the reference as soon as the fields are filled

  // Submitting must NOT require a top-level navigation. A gateway's 3DS challenge is a modal
  // iframe on the same page, so demanding navigation turns every challenge into a 20s timeout,
  // a cancelled purchase and a stranded card — with confirm() never reaching the settled page.
  // Invariant 8 still holds: an unknown outcome is still a failure, it is just decided after the
  // decline check and the caller's gate rather than before them.
  let submit: Awaited<ReturnType<typeof submitLocator>>;
  try {
    submit = await submitLocator(page, numberHit, opts.submitSelector);
  } catch {
    return { ok: false, error: "FIELDS_NOT_FOUND" };
  }
  await submit.click().catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

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
