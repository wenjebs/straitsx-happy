import type { MerchantAdapter } from "../types.js";

const HOSTS = new Set(["127.0.0.1", "localhost"]);

const configuredHost = (() => {
  try {
    return new URL(process.env.DEMO_STORE_URL ?? "").hostname;
  } catch {
    return null;
  }
})();

export const demoStoreAdapter: MerchantAdapter = {
  name: "demo-store",

  matches: (url) => HOSTS.has(url.hostname) || url.hostname === configuredHost,

  async toPaymentPage(page) {
    if (!page.url().includes("/checkout")) {
      await page.locator('a[href^="/checkout"]').first().click();
    }
    await page
      .locator('input[autocomplete="cc-number"]')
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  },

  async readFinalTotalCents(page) {
    // A structured attribute, never the rendered price text — page prose is never trusted.
    const raw = await page
      .locator("[data-total-cents]")
      .first()
      .getAttribute("data-total-cents", { timeout: 5_000 });
    const cents = Number(raw);
    if (!Number.isInteger(cents) || cents <= 0)
      throw new Error(`total unreadable: ${JSON.stringify(raw)}`);
    return cents;
  },

  // No confirmOrder and no submitSelector: the store emits [data-order-ref], which payWithCard's
  // built-in check reads, and the library already scopes submission to the card form.
};
