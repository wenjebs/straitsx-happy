import type { Page } from "playwright";

/**
 * Product page → a checkout showing card fields.
 *
 * The first version of this looked for a checkout link and card fields and nothing else, so it sat
 * on a product page with an ADD TO CART button in plain sight and timed out with "could not reach
 * a page with card fields". An empty cart has no checkout link to find.
 *
 * Deliberately conservative about the things that change what is bought:
 *
 *   - The variant selector is never touched. Shops like Cocomo price variants as bundles —
 *     "(BUY 1)", "(BUY 2+1 FREE)" — where only the default is inside the card's S$5-30 band and
 *     the bundles run S$36-103. The default selection is the one whose price was approved.
 *   - Quantity is never changed. It defaults to 1, and 2 of something is not what was approved.
 */

const ADD_TO_CART = [
  'button[name="add"]',
  'form[action*="/cart/add"] button[type="submit"]',
  'button[data-action="add-to-cart"]',
];

const ADD_TO_CART_TEXT = /add to (cart|bag|basket)|buy now/i;

export type CartStep = { step: string; detail?: string };

async function hasCardField(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const el = frame.locator('input[autocomplete="cc-number"]').first();
    if ((await el.count().catch(() => 0)) === 0) continue;
    // Shopify renders decoy 2px copies of this field in several frames; only a field wide enough
    // to type into means we are really on the payment step. See fill.ts.
    const box = await el.boundingBox().catch(() => null);
    if (box && box.width >= 60) return true;
  }
  return false;
}

async function clickAddToCart(page: Page): Promise<boolean> {
  for (const selector of ADD_TO_CART) {
    const el = page.locator(selector).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 10_000 }).catch(() => {});
      return true;
    }
  }
  const byText = page.getByRole("button", { name: ADD_TO_CART_TEXT }).first();
  if ((await byText.count()) > 0) {
    await byText.click({ timeout: 10_000 }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Walks a product URL to a payment page.
 *
 * Returns the steps taken, so a failure says where it got to rather than just "could not reach a
 * page with card fields" — which was true and useless.
 */
export async function toPaymentPage(
  page: Page,
  productUrl: string,
  log: (m: string, d?: Record<string, unknown>) => void = () => {},
): Promise<CartStep[]> {
  const steps: CartStep[] = [];
  const note = (step: string, detail?: string) => {
    steps.push(detail === undefined ? { step } : { step, detail });
    log(`cart: ${step}`, detail ? { detail } : undefined);
  };

  await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  note("opened product", page.url());

  if (await hasCardField(page)) {
    note("already on a payment page");
    return steps;
  }

  const added = await clickAddToCart(page);
  note(added ? "clicked add to cart" : "no add-to-cart button found");
  if (added) await page.waitForTimeout(2500);

  // A checkout link on the page first. It carries whatever the shop encoded in it — demo-store
  // puts the sku in the query string, and a bare /checkout there is a 404.
  const link = page.locator('a[href*="checkout" i]').first();
  if ((await link.count()) > 0 && (await link.isVisible().catch(() => false))) {
    await link.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    note("followed checkout link", page.url());
    if (await hasCardField(page)) {
      note("card fields present");
      return steps;
    }
  }

  // Otherwise the shop's own /checkout route. A cart drawer's checkout button often sits in an
  // overlay that is fragile to click, and every Shopify shop serves this route.
  const origin = new URL(page.url()).origin;
  await page
    .goto(`${origin}/checkout`, { waitUntil: "domcontentloaded", timeout: 45_000 })
    .catch(() => {});
  note("navigated to checkout", page.url());

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await hasCardField(page)) {
      note("card fields present");
      return steps;
    }
    await page.waitForTimeout(500);
  }

  note("no card fields after checkout");
  throw new Error(
    `could not reach a page with card fields — got as far as ${page.url()} (${steps
      .map((s) => s.step)
      .join(" → ")})`,
  );
}
