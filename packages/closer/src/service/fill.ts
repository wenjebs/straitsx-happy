import type { Page } from "playwright";
import type { CardMaterial } from "./card.js";

/**
 * Types the card into the checkout.
 *
 * PCI DSS pushes serious gateways to render the number inside an iframe they control — Shopify
 * serves it from checkout.pci.shopifyinc.com — and Playwright's page-level locators do not cross
 * frame boundaries. Searching the page alone finds nothing at essentially every real merchant, so
 * every frame is searched. Verified against a live Shopify checkout over AgentCore.
 */
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
};

/** Tests set CARD_TYPE_DELAY_MS=0; real runs want human-ish timing. */
const typeDelayMs = () => {
  const override = process.env.CARD_TYPE_DELAY_MS;
  if (override !== undefined && override !== "") return Number(override);
  return 70 + Math.random() * 80;
};

async function fillFirst(page: Page, candidates: string[], value: string): Promise<boolean> {
  const scopes = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const sel of candidates) {
    for (const scope of scopes) {
      const el = scope.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click();
        // Typed, never fill(). Sixteen digits appearing instantly with no keystrokes is a named
        // fraud signal, and the 3DS challenge it invites kills a single-use card.
        await el.pressSequentially(value, { delay: typeDelayMs() });
        return true;
      }
    }
  }
  return false;
}

export async function typeCardInto(page: Page, card: CardMaterial): Promise<void> {
  if (!(await fillFirst(page, SELECTORS.number, card.pan))) {
    throw new Error("no card number field in any frame of this page");
  }
  await fillFirst(page, SELECTORS.expiry, `${card.expiryMonth}/${card.expiryYear}`);
  await fillFirst(page, SELECTORS.cvc, card.cvc);
}
