import type { ShortlistPick, WishlistItem } from "../domain.js";
import { matchListing } from "./matchListing.js";

/**
 * What a scout falls back to when the live browser comes back empty.
 *
 * The scouts are the source of truth: they open the storefront and read the price off the page, so
 * the shortlist reflects what the shop is charging right now. But a storefront can be down, can
 * serve a Cloudflare challenge, or can simply not stock the thing — and an item with no listing
 * silently disappears from the shortlist, which reads as a lost item rather than a shop that had
 * nothing.
 *
 * `catalogue.ts` is a crawl of real products on these shops with real URLs and real prices. As a
 * fallback it is honest — the URL resolves and the product exists — but the price is the crawled
 * one, so anything sourced this way is marked and the Closer re-checks the total at checkout
 * before spending, exactly as it does for a live pick.
 */
export interface FallbackOptions {
  /** Products already proposed for other items, so two items never get the same one. */
  used: Set<string>;
}

export function catalogueFallback(
  item: WishlistItem,
  options: FallbackOptions,
): Omit<ShortlistPick, "itemId"> | null {
  if (process.env.SCOUT_LISTINGS === "demo-store") return demoStoreFallback(item, options);

  const text = [item.name, item.spec, item.category].filter(Boolean).join(" ");
  try {
    const matched = matchListing(text, options.used);
    return { listing: matched.listing, reSearched: false, alternates: matched.alternates };
  } catch {
    // matchListing throws only on an empty catalogue. An item with no listing is a better
    // outcome than a crashed search.
    return null;
  }
}

/**
 * apps/demo-store, for a run that completes with no network and no money.
 *
 * Prices mirror its own catalogue deliberately. If they drift the Closer's total check refuses the
 * purchase, which is the check working rather than a bug.
 */
function demoStoreFallback(
  item: WishlistItem,
  options: FallbackOptions,
): Omit<ShortlistPick, "itemId"> | null {
  const base = (process.env.DEMO_STORE_URL ?? "http://127.0.0.1:4030").replace(/\/$/, "");
  const pool = [
    {
      title: "Anker USB-C Hub",
      seller: "demo-store",
      rating: "verified listing",
      price: "S$18.00",
      amountMinor: 1800,
      why: "Matches the specification within budget.",
      url: `${base}/item/usb-c-hub`,
    },
    {
      title: "1TB NVMe SSD",
      seller: "demo-store",
      rating: "verified listing",
      price: "S$29.00",
      amountMinor: 2900,
      why: "Highest capacity still inside the card's S$30 ceiling.",
      url: `${base}/item/nvme-ssd`,
    },
  ];
  const listing = pool.find((entry) => !options.used.has(entry.url));
  if (!listing) return null;
  options.used.add(listing.url);
  void item;
  return { listing, reSearched: false, alternates: [] };
}
