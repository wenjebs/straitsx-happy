/**
 * Ask a real shop the only question that matters, without spending anything.
 *
 *   pnpm --filter @happy/closer probe https://shop.example.sg/product/thing
 *
 * It opens the page in your saved profile, walks toward the payment page, and reports whether a
 * card form is reachable and what the total is. Then it stops.
 *
 * It NEVER issues a card and never submits a form. It cannot spend money — it does not even load
 * @happy/pay. Use it to sort candidate merchants before any of them touch the money path.
 */
import { chromium } from "playwright";
import { createProfileStore } from "../src/profiles.js";

const url = process.argv[2];

if (!url) {
  console.error("usage: pnpm --filter @happy/closer probe <product-url>");
  process.exit(1);
}

const store = createProfileStore();
const host = new URL(url).hostname;
const connected = store.status(host).connected;
console.log(`session for ${host}: ${connected ? "connected" : "none — run `login` first"}`);

const CARD = 'input[autocomplete="cc-number"], input[name*="card" i][name*="num" i]';
const BUY = /buy now|add to cart|checkout|proceed to (pay|checkout)|continue to payment/i;

/**
 * Never clickable, at any hop. On a marketplace where the account already has a saved card, these
 * buttons are the irreversible one — the probe would buy something with the user's own money while
 * pretending to be read-only.
 */
const NEVER = /place order|pay now|confirm (order|payment)|complete purchase|submit order/i;

const context = connected
  ? await store.contextFor(host)
  : await (await chromium.launch({ headless: false })).newContext();

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: "load", timeout: 45_000 });
// A shop that bounces automation redirects AFTER load. Reading the address too early reports the
// address you asked for and hides the wall you actually landed on. Shopee does exactly this.
await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(3_000);

const landed = page.url();
const CHALLENGE = /\/verify\/|\/captcha|\/challenge|login[_-]?required|access[_-]?denied/i;
const bounced = CHALLENGE.test(landed) || landed !== url;
if (bounced) console.log(`redirected to: ${landed}`);

const hasCard = async () => (await page.locator(CARD).first().count()) > 0;

for (let hop = 0; hop < 3 && !(await hasCard()); hop++) {
  const link = page.locator("a, button").filter({ hasText: BUY }).first();
  if ((await link.count()) === 0) break;
  const label = (await link.textContent())?.trim().replace(/\s+/g, " ").slice(0, 40) ?? "";
  if (NEVER.test(label)) {
    console.log(`hop ${hop + 1}: refusing to click "${label}" — that button buys something`);
    break;
  }
  console.log(`hop ${hop + 1}: clicking "${label}"`);
  await link.click({ timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
}

const cardForm = await hasCard();
const totals = await page
  .locator(":text-matches('total', 'i')")
  .allInnerTexts()
  .catch(() => [] as string[]);
const loginWall = /sign in|log in|create account/i.test(await page.content());

console.log(`\n  url:        ${page.url()}`);
console.log(`  challenge:  ${CHALLENGE.test(page.url()) ? "YES — the shop bounced this browser" : "no"}`);
console.log(`  card form:  ${cardForm ? "yes — the agent can type a card here" : "NO"}`);
console.log(`  sign-in:    ${loginWall ? "the page mentions signing in" : "no sign-in prompt seen"}`);
console.log(`  totals:     ${totals.slice(-3).join(" | ").replace(/\s+/g, " ").slice(0, 160) || "none found"}`);
console.log(`\n  verdict:    ${cardForm ? "worth a real attempt" : "not usable without a per-shop adapter"}\n`);
console.log("nothing was bought, and no card was issued.\n");

await context.close();
process.exit(0);
