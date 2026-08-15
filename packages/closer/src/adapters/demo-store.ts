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
    // The card fields may sit in a gateway iframe — Shopify serves them from
    // checkout.pci.shopifyinc.com, and every PCI-compliant checkout does something similar. A
    // page-level wait finds nothing there, so look in every frame before declaring the page ready.
    const deadline = Date.now() + 10_000;
    for (;;) {
      for (const frame of page.frames()) {
        const field = frame.locator('input[autocomplete="cc-number"]').first();
        if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) return;
      }
      if (Date.now() > deadline) throw new Error("no card field in any frame of this page");
      await page.waitForTimeout(250);
    }
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
