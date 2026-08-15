/**
 * Reads title and price for the stubbed Shopee listings, from a LOCAL browser.
 *
 * Two jobs. It gets real prices into stubListings.ts rather than guesses — the Closer checks the
 * merchant's displayed total against the approved amount, so a wrong fixture fails the purchase.
 *
 * And it answers something worth knowing: Shopee blocks AWS datacentre IPs, but this machine is on
 * a residential one. If these load here and not there, the block is purely about egress, and
 * CLOSER_BROWSER=local is a working path to a real Shopee checkout — at the cost of the AgentCore
 * live view and human takeover.
 *
 *   pnpm --filter @happy/closer exec tsx probe/shopee-prices.ts
 */
import { chromium } from "playwright";

const URLS = [
  "https://shopee.sg/Red-Bull-Kratingdaeng-Energy-Drink-250ml-Cans-Set-of-24-(Thailand-Origin)-i.1840063679.47111344816",
  "https://shopee.sg/-COSRX-OFFICIAL-Salicylic-Acid-Daily-Gentle-Cleanser-150ml-Salicylic-Acid-0.5-Tea-Tree-Leaf-Oil-0.2-Acne-Treatment-Cleanser-for-Acne-prone-Skin-BHA-Cleanser-i.116704504.1933154709",
  "https://shopee.sg/IUIGA-1.8L-Glass-Baking-Dish-Heat-Resistant-Oven-Microwave-Safe-Casserole-Roasting-Pan-with-Detachable-Handles-i.1250897527.40532646220",
];

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

for (const url of URLS) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Settle: a bot bounce lands AFTER domcontentloaded, so reading immediately reports the URL we
    // asked for rather than the one we got.
    await page.waitForTimeout(6000);

    const title = await page.title();
    const blocked = /unavailable|verify|error/i.test(page.url() + title);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000));
    const price = bodyText.match(/\$\s?([\d,]+\.\d{2})/)?.[0] ?? null;

    console.log(
      JSON.stringify(
        {
          url: page.url().slice(0, 80),
          title: title.slice(0, 70),
          blocked,
          firstPriceOnPage: price,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.log(JSON.stringify({ url: url.slice(0, 70), error: (e as Error).message }));
  } finally {
    await page.close();
  }
}

await browser.close();
