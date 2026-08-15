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
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const url = process.argv[2];
const dir = process.env.CLOSER_PROFILE_DIR ?? "./closer-profile";

if (!url) {
  console.error("usage: pnpm --filter @happy/closer probe <product-url>");
  process.exit(1);
}

const CARD = 'input[autocomplete="cc-number"], input[name*="card" i][name*="num" i]';
const BUY = /buy now|add to cart|checkout|proceed to (pay|checkout)|place order|continue to payment/i;

const context = existsSync(dir)
  ? await chromium.launchPersistentContext(dir, { headless: false })
  : await (await chromium.launch({ headless: false })).newContext();

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: "load", timeout: 45_000 });

const hasCard = async () => (await page.locator(CARD).first().count()) > 0;

for (let hop = 0; hop < 3 && !(await hasCard()); hop++) {
  const link = page.locator("a, button").filter({ hasText: BUY }).first();
  if ((await link.count()) === 0) break;
  console.log(`hop ${hop + 1}: clicking "${(await link.textContent())?.trim().slice(0, 40)}"`);
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
console.log(`  card form:  ${cardForm ? "yes — the agent can type a card here" : "NO"}`);
console.log(`  sign-in:    ${loginWall ? "the page mentions signing in" : "no sign-in prompt seen"}`);
console.log(`  totals:     ${totals.slice(-3).join(" | ").replace(/\s+/g, " ").slice(0, 160) || "none found"}`);
console.log(`\n  verdict:    ${cardForm ? "worth a real attempt" : "not usable without a per-shop adapter"}\n`);
console.log("nothing was bought, and no card was issued.\n");

await context.close();
process.exit(0);
