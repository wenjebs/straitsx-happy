import type { Page } from "playwright";
import type { VerifiedMerchant } from "../merchants.js";

/**
 * Reading a Shopify storefront through a real browser.
 *
 * Every call navigates first, because the point of the AgentCore session is that a viewer watches
 * the page the scout is actually on. The data is then read from Shopify's own JSON documents
 * (`/search/suggest.json` and `/products/<handle>.js`) via an in-page fetch on the same origin,
 * rather than scraped out of the rendered theme.
 *
 * That split matters for money: a theme renders "From $25.00" for a product whose cheapest variant
 * is $25 and whose default variant is $48, and a scout that believes the rendered string shortlists
 * something the card cannot cover. `.js` returns the variant price as an integer number of cents.
 *
 * All four verified merchants price in SGD, so cents map straight onto `amountMinor`.
 */
export interface Candidate {
  merchantId: string;
  host: string;
  handle: string;
  title: string;
  url: string;
  priceMinor: number;
  imageUrl?: string | undefined;
}

export interface ProductDetail extends Candidate {
  vendor: string;
  available: boolean;
  /** Trimmed hard — this goes into a model prompt and the full body copy is mostly markup. */
  summary: string;
}

const NAV_TIMEOUT = 45_000;

export async function searchStore(
  page: Page,
  merchant: VerifiedMerchant,
  query: string,
  limit = 8,
): Promise<Candidate[]> {
  const url = `${merchant.origin}/search?q=${encodeURIComponent(query)}&type=product`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

  const suggested = await page
    .evaluate(
      async ([q, max]) => {
        const response = await fetch(
          `/search/suggest.json?q=${encodeURIComponent(String(q))}&resources[type]=product&resources[limit]=${Number(max)}`,
          { headers: { accept: "application/json" } },
        );
        if (!response.ok) return null;
        const body = (await response.json()) as {
          resources?: { results?: { products?: unknown[] } };
        };
        return body.resources?.results?.products ?? null;
      },
      [query, limit] as const,
    )
    .catch(() => null);

  if (suggested && suggested.length > 0) {
    return suggested
      .map((raw) => toCandidate(raw, merchant))
      .filter((candidate): candidate is Candidate => candidate !== null)
      .slice(0, limit);
  }

  // Predictive search is disabled on some themes. Fall back to the rendered grid, accepting that
  // its price string is only good enough to order candidates — `openProduct` re-reads the real one.
  const scraped = await page.evaluate((max) => {
    const seen = new Set<string>();
    const out: { handle: string; title: string; price: string }[] = [];
    for (const anchor of Array.from(document.querySelectorAll('a[href*="/products/"]'))) {
      const href = anchor.getAttribute("href") ?? "";
      const handle = href.split("/products/")[1]?.split(/[?#]/)[0];
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      const text = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
      out.push({ handle, title: text.slice(0, 140), price: text });
      if (out.length >= Number(max)) break;
    }
    return out;
  }, limit);

  return scraped.map((row) => ({
    merchantId: merchant.id,
    host: merchant.host,
    handle: row.handle,
    title: row.title,
    url: `${merchant.origin}/products/${row.handle}`,
    priceMinor: parsePriceMinor(row.price) ?? 0,
  }));
}

export async function openProduct(
  page: Page,
  merchant: VerifiedMerchant,
  handle: string,
): Promise<ProductDetail> {
  const url = `${merchant.origin}/products/${handle}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

  const detail = await page.evaluate(async (productHandle) => {
    const response = await fetch(`/products/${productHandle}.js`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as {
      title?: string;
      price?: number;
      vendor?: string;
      available?: boolean;
      featured_image?: string | null;
      description?: string;
      variants?: { price?: number; available?: boolean }[];
    };
  }, handle);

  if (!detail) {
    throw new Error(`${merchant.host}/products/${handle} did not return product JSON`);
  }

  // `price` is the default variant. Prefer the cheapest variant that is actually in stock — that is
  // the one a scout can buy, and the one whose price has to fit inside the card bounds.
  const buyable = (detail.variants ?? []).filter(
    (variant) => variant.available && typeof variant.price === "number",
  );
  const priceMinor = buyable.length
    ? Math.min(...buyable.map((variant) => variant.price as number))
    : (detail.price ?? 0);

  return {
    merchantId: merchant.id,
    host: merchant.host,
    handle,
    title: detail.title ?? handle,
    url,
    priceMinor,
    imageUrl: absoluteImage(detail.featured_image, merchant.origin),
    vendor: detail.vendor || merchant.name,
    available: detail.available ?? buyable.length > 0,
    summary: (detail.description ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400),
  };
}

function toCandidate(raw: unknown, merchant: VerifiedMerchant): Candidate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const product = raw as {
    handle?: unknown;
    title?: unknown;
    price?: unknown;
    url?: unknown;
    image?: unknown;
  };
  if (typeof product.handle !== "string" || typeof product.title !== "string") return null;
  return {
    merchantId: merchant.id,
    host: merchant.host,
    handle: product.handle,
    title: product.title,
    url: `${merchant.origin}/products/${product.handle}`,
    priceMinor: parsePriceMinor(typeof product.price === "string" ? product.price : "") ?? 0,
    imageUrl: absoluteImage(typeof product.image === "string" ? product.image : null, merchant.origin),
  };
}

/** "$25.00", "From $25.00", "SGD 25" → 2500. Returns null when there is no number at all. */
function parsePriceMinor(text: string): number | null {
  const match = text.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  if (!match?.[1]) return null;
  return Math.round(Number.parseFloat(match[1]) * 100);
}

function absoluteImage(value: string | null | undefined, origin: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${origin}${value}`;
  return value;
}
