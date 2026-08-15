import type { Frame, Locator, Page } from "playwright";
import type { CardMaterial } from "./card.js";

/**
 * Types the card into the checkout.
 *
 * PCI DSS pushes serious gateways to render the number inside an iframe they control — Shopify
 * serves it from checkout.pci.shopifyinc.com — and Playwright's page-level locators do not cross
 * frame boundaries. Searching the page alone finds nothing at essentially every real merchant, so
 * every frame is searched.
 *
 * ## The decoy trap
 *
 * Searching every frame is not enough, and the reason cost a real debugging session to find.
 * Shopify ships the SAME eight-input form into every one of its field iframes — number, name,
 * expiry, verification_value and more — and shows exactly one per frame. On a live checkout
 * `input[autocomplete="cc-number"]` matches in SIX frames, and the seven decoys in each are not
 * hidden: they are shrunk to about 2x2px with `visibility: visible`, so Playwright's `isVisible()`
 * returns TRUE for all of them.
 *
 * A first-match locator therefore types the card number into a 2px field inside expiry-ltr.html
 * roughly five times out of six. Nothing throws. The checkout simply fails with an empty card
 * number, on a single-use card that has already been minted and has ten minutes to live.
 *
 * So a field is only accepted if it is big enough for a person to type into. Frame URL is used to
 * prefer the right frame first, but size is the check that actually decides, because it holds on
 * gateways that do not name their frames the way Shopify does.
 */

/** Below this, a "visible" input is a decoy rather than something a person could use. */
const MIN_FIELD_WIDTH = 60;

const SELECTORS = {
  number: [
    'input[autocomplete="cc-number"]',
    'input[name="number"]',
    'input[name*="card" i][name*="num" i]',
    'input[id*="cardnumber" i]',
    'input[name="cardNumber"]',
  ],
  expiry: [
    'input[autocomplete="cc-exp"]',
    'input[name="expiry"]',
    'input[name*="exp" i]',
    'input[id*="exp" i]',
  ],
  cvc: [
    'input[autocomplete="cc-csc"]',
    'input[name="verification_value"]',
    'input[name*="cvc" i]',
    'input[name*="cvv" i]',
    'input[id*="cvc" i]',
  ],
};

/** Frame filename hints, most specific first. Shopify names each field's frame after the field. */
const FRAME_HINTS: Record<keyof typeof SELECTORS, string[]> = {
  number: ["number-"],
  expiry: ["expiry-"],
  cvc: ["verification", "cvv", "cvc"],
};

/** Tests set CARD_TYPE_DELAY_MS=0; real runs want human-ish timing. */
const typeDelayMs = () => {
  const override = process.env.CARD_TYPE_DELAY_MS;
  if (override !== undefined && override !== "") return Number(override);
  return 70 + Math.random() * 80;
};

/** A field a person could actually type into, as opposed to a 2px decoy. */
async function isRealField(el: Locator): Promise<boolean> {
  if ((await el.count()) === 0) return false;
  if (!(await el.isVisible().catch(() => false))) return false;
  const box = await el.boundingBox().catch(() => null);
  return box !== null && box.width >= MIN_FIELD_WIDTH;
}

/**
 * Orders frames so the one named after this field is tried first.
 *
 * Only a preference: the size check is what guarantees correctness. A gateway that names its
 * frames differently still works, just with more candidates tried.
 */
function orderedScopes(page: Page, field: keyof typeof SELECTORS): (Page | Frame)[] {
  const children = page.frames().filter((f) => f !== page.mainFrame());
  const hints = FRAME_HINTS[field];
  const preferred = children.filter((f) => hints.some((h) => f.url().includes(h)));
  const rest = children.filter((f) => !preferred.includes(f));
  return [...preferred, page, ...rest];
}

async function fillField(
  page: Page,
  field: keyof typeof SELECTORS,
  value: string,
): Promise<boolean> {
  for (const selector of SELECTORS[field]) {
    for (const scope of orderedScopes(page, field)) {
      const el = scope.locator(selector).first();
      if (!(await isRealField(el))) continue;
      await el.click();
      // Typed, never fill(). Sixteen digits appearing instantly with no keystrokes is a named
      // fraud signal, and the 3DS challenge it invites kills a single-use card.
      await el.pressSequentially(value, { delay: typeDelayMs() });
      return true;
    }
  }
  return false;
}

export async function typeCardInto(page: Page, card: CardMaterial): Promise<void> {
  if (!(await fillField(page, "number", card.pan))) {
    throw new Error("no usable card number field in any frame of this page");
  }
  // Expiry and CVC are best-effort: some gateways derive or defer them, and failing the whole
  // purchase over a field the page did not ask for would strand an already-minted card.
  await fillField(page, "expiry", `${card.expiryMonth}/${card.expiryYear}`);
  await fillField(page, "cvc", card.cvc);
}
