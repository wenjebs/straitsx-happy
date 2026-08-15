import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "playwright";
import { typeCardInto } from "./fill.js";
import { attachFrames } from "./frames.js";
import { createJobStore } from "./jobs.js";
import { createLiveView } from "./liveview.js";
import { runPurchase } from "./run.js";
import { browserForEnv, createPurchaseServer, releaseBrowser } from "./server.js";
import { readMerchantTotal } from "./total.js";
import type { PurchaseJobInput } from "./verify.js";

export async function startPurchaseService(port?: number): Promise<Server> {
  const token = process.env.PURCHASE_AGENT_API_TOKEN;
  if (!token) throw new Error("PURCHASE_AGENT_API_TOKEN is required");
  const listenPort = port ?? Number(process.env.CLOSER_SERVICE_PORT ?? 4042);

  const jobs = createJobStore();
  const view = createLiveView();

  const server = createPurchaseServer({
    token,
    jobs,
    view,
    startRun: (job: PurchaseJobInput) => {
      void runPurchase(
        {
          jobs,
          view,
          browserFor: browserForEnv,
          releaseBrowser,
          liveUrlFor: (attemptId) =>
            `${publicBaseUrl(server, listenPort)}/v1/live/${encodeURIComponent(attemptId)}`,
          attachFrames: (page, attemptId) => attachFrames(page, attemptId, view),
          toPaymentPage,
          fillCard: typeCardInto,
          readTotalMinor,
          submit: submitAndReadOrderRef,
        },
        job,
      );
    },
  });

  await new Promise<void>((r) => server.listen(listenPort, "127.0.0.1", r));
  return server;
}

/**
 * The base the frontend will use to reach the live view.
 *
 * Read from the bound address rather than the requested port, because tests bind to 0 and would
 * otherwise hand Happy a URL pointing at port 0.
 */
function publicBaseUrl(server: Server, fallbackPort: number): string {
  if (process.env.CLOSER_PUBLIC_BASE_URL) return process.env.CLOSER_PUBLIC_BASE_URL;
  const addr = server.address() as AddressInfo | null;
  return `http://127.0.0.1:${addr?.port ?? fallbackPort}`;
}

/** Opens the listing and gets to a page that has card fields on it. */
async function toPaymentPage(page: Page, job: PurchaseJobInput): Promise<void> {
  if (!job.listing.url) throw new Error("listing has no url");
  await page.goto(job.listing.url, { waitUntil: "domcontentloaded", timeout: 45_000 });

  // Already on a page with card fields? Nothing to do.
  if (await hasCardField(page)) return;

  const checkout = page.locator('a[href*="checkout" i]').first();
  if ((await checkout.count()) > 0) {
    await checkout.click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await hasCardField(page)) return;
    await page.waitForTimeout(250);
  }
  throw new Error("could not reach a page with card fields");
}

async function hasCardField(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const field = frame.locator('input[autocomplete="cc-number"]').first();
    if ((await field.count().catch(() => 0)) > 0) return true;
  }
  return false;
}

/**
 * The merchant's own total, read from the page it is charging on.
 *
 * Throwing when it cannot be read is the point: a total we cannot see is a purchase we must not
 * make. Guessing here is what lets a merchant charge whatever it likes.
 */
async function readTotalMinor(page: Page): Promise<number> {
  const reading = await readMerchantTotal(page);
  if (!reading) throw new Error("could not read the merchant's total from the page");
  return reading.amountMinor;
}

/**
 * Submits and looks for an order reference.
 *
 * Deliberately does NOT wait for a top-level navigation. A gateway's 3DS challenge is a modal
 * iframe on the same page, and demanding navigation turns every challenge into a timeout — a
 * cancelled purchase and a card stranded with the money already gone.
 */
async function submitAndReadOrderRef(page: Page): Promise<string | null> {
  const submit = page
    .getByRole("button", { name: /pay now|place order|complete order|^pay\b|confirm order/i })
    .first();
  if ((await submit.count()) === 0) return null;
  await submit.click();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ref = await page
      .locator("[data-order-ref]")
      .first()
      .getAttribute("data-order-ref")
      .catch(() => null);
    if (ref) return ref;
    await page.waitForTimeout(300);
  }
  return null;
}
