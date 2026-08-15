/**
 * The decoy trap, reproduced.
 *
 * On a live Shopify checkout `input[autocomplete="cc-number"]` matches in six frames. Shopify
 * ships the same eight-input form into each and shows one per frame; the other seven are shrunk to
 * about 2x2px but keep `visibility: visible`, so Playwright's isVisible() returns true for all of
 * them. A first-match locator types the card number into a 2px field and nothing throws — the
 * checkout just fails, on a card that has already been minted.
 *
 * This builds that shape locally and asserts the digits land in the field a person could use.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { typeCardInto } from "../src/service/fill.js";

const PAN = "4242424242424242";

// One "decoy" frame that shows a 2px card-number input, and one real frame that shows a full-width
// one — the same trap Shopify's checkout lays, minus the rest of the checkout.
const decoyFrame = `<!doctype html><meta charset="utf-8"><body>
  <input id="number" name="number" autocomplete="cc-number"
         style="width:2px;height:2px;padding:0;border:0;visibility:visible">
</body>`;

const realFrame = `<!doctype html><meta charset="utf-8"><body>
  <input id="number" name="number" autocomplete="cc-number"
         style="width:320px;height:32px;visibility:visible">
</body>`;

let server: Server;
let base = "";
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // Decoy frame FIRST in document order, so a first-match locator picks it.
    if (url.startsWith("/expiry-ltr")) return res.end(decoyFrame);
    if (url.startsWith("/number-ltr")) return res.end(realFrame);
    res.end(`<!doctype html><meta charset="utf-8"><title>checkout</title><body>
      <iframe src="/expiry-ltr.html" width="300" height="60"></iframe>
      <iframe src="/number-ltr.html" width="400" height="60"></iframe>
    </body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  process.env.CARD_TYPE_DELAY_MS = "0";
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("typing the card into a checkout", () => {
  it("puts the digits in the usable field, not the 2px decoy that also reports visible", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`, { waitUntil: "load" });

    await typeCardInto(page, {
      pan: PAN,
      expiryMonth: "12",
      expiryYear: "40",
      cvc: "123",
    });

    const values = await Promise.all(
      page
        .frames()
        .filter((f) => f !== page.mainFrame())
        .map(async (f) => ({
          url: f.url(),
          value: await f.locator("#number").inputValue().catch(() => ""),
        })),
    );

    const real = values.find((v) => v.url.includes("number-ltr"));
    const decoy = values.find((v) => v.url.includes("expiry-ltr"));

    expect(real?.value).toBe(PAN);
    // The failure this test exists for: digits in the decoy, checkout empty, card burned.
    expect(decoy?.value).toBe("");

    await page.close();
  }, 120_000);

  it("refuses rather than silently succeeding when no usable field exists", async () => {
    const page = await browser.newPage();
    await page.setContent(
      `<input name="number" autocomplete="cc-number" style="width:2px;height:2px">`,
    );
    await expect(
      typeCardInto(page, { pan: PAN, expiryMonth: "12", expiryYear: "40", cvc: "123" }),
    ).rejects.toThrow(/no usable card number field/i);
    await page.close();
  }, 120_000);
});
