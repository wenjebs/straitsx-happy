import type { Page } from "playwright";

/**
 * Reads the merchant's own displayed total, in cents.
 *
 * This number decides whether we buy, so it must never be guessed. Every strategy below either
 * finds a total it can defend or returns null, and the caller treats "no total" as a refusal
 * rather than as permission. Returning a plausible-but-wrong figure is the failure that lets a
 * merchant charge whatever it likes.
 *
 * The strategies run most-trustworthy first:
 *
 *   1. A machine-readable attribute the page put there on purpose. `apps/demo-store` and Shopify's
 *      legacy checkout both do this, and it is in minor units already, so nothing is parsed.
 *   2. A row whose label is exactly "Total" — not "Subtotal", not "Total savings" — paired with a
 *      currency amount inside the same container. This is what a person reads.
 *
 * There is deliberately no "largest amount on the page" fallback. On a checkout showing a cart
 * subtotal, a shipping upsell and a loyalty balance, the largest number is frequently not the
 * total, and a wrong answer here spends money.
 */

/** Attributes that carry a total in minor units, in the order we trust them. */
const MINOR_UNIT_ATTRS = [
  "data-total-cents",
  "data-checkout-payment-due-target",
] as const;

export type TotalReading = {
  amountMinor: number;
  /** How it was found, so a surprising number can be traced rather than argued about. */
  source: string;
  /** The text the number came from, for logs. */
  raw: string;
};

export async function readMerchantTotal(page: Page): Promise<TotalReading | null> {
  // Search the page and every child frame: a checkout may render its summary in an iframe.
  const scopes = [page, ...page.frames().filter((f) => f !== page.mainFrame())];

  for (const scope of scopes) {
    const reading = await scope
      .evaluate(
        ({ attrs }) => {
          const g = globalThis as unknown as {
            document: {
              querySelector: (s: string) => { getAttribute: (a: string) => string | null } | null;
              querySelectorAll: (s: string) => ArrayLike<{
                textContent: string | null;
                parentElement: unknown;
              }>;
              body: { innerText: string } | null;
            };
          };

          // 1. A deliberate machine-readable total.
          for (const attr of attrs) {
            const el = g.document.querySelector(`[${attr}]`);
            const raw = el?.getAttribute(attr);
            if (raw && /^\d+$/.test(raw.trim())) {
              return { amountMinor: Number(raw.trim()), source: `attribute ${attr}`, raw };
            }
          }

          // 2. A row labelled exactly "Total", paired with an amount in the same container.
          //    Walks up a few levels because the label and the figure are usually siblings-of-
          //    siblings rather than neighbours.
          // Structurally typed rather than using the DOM lib: this file is typechecked with Node's
          // libs. The body still runs in the page, where these are real elements.
          type El = { textContent: string | null; parentElement: El | null };
          const money = /(?:S?\$|SGD)\s?([\d,]+\.\d{2})/;
          const nodes = Array.from(
            g.document.querySelectorAll("*") as unknown as ArrayLike<El>,
          ) as El[];

          for (const node of nodes) {
            const own = (node.textContent ?? "").trim();
            if (!/^total$/i.test(own)) continue;

            let container: El | null = node;
            for (let up = 0; up < 4 && container; up++) {
              container = container.parentElement;
              const text = (container?.textContent ?? "").replace(/\s+/g, " ");
              // Reject containers that swept in a different line's label.
              if (/subtotal|savings|discount|shipping/i.test(text)) continue;
              const hit = text.match(money);
              if (hit?.[1]) {
                return {
                  amountMinor: Math.round(Number(hit[1].replace(/,/g, "")) * 100),
                  source: "row labelled Total",
                  raw: hit[0],
                };
              }
            }
          }

          return null;
        },
        { attrs: MINOR_UNIT_ATTRS as unknown as string[] },
      )
      .catch(() => null);

    if (reading && Number.isFinite(reading.amountMinor) && reading.amountMinor > 0) {
      return reading as TotalReading;
    }
  }

  return null;
}
