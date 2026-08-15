/**
 * Test targets.
 *
 * The Shopee links are the ones we are trying to make work with Skyvern. A plain Playwright
 * browser never reaches any of them: Shopee redirects to /verify/traffic/error before the product
 * page renders. They are here so a driver can be pointed at all four in one go.
 *
 * The Shopify links are the fallback that already works end to end as a guest, with the card
 * fields in a gateway iframe. Keep them: if Skyvern cannot pass Shopee, these are the demo.
 */

export type TestLink = {
  id: string;
  url: string;
  /** What we expect today, so a run that differs is interesting rather than noise. */
  expect: "blocked" | "reachable";
  note: string;
};

export const SHOPEE_LINKS: TestLink[] = [
  {
    id: "roku-1",
    url: "https://shopee.sg/Roku-Gin-43-700ml-i.2685549.19284714232?extraParams=%7B%22display_model_id%22%3A232081286256%2C%22model_selection_logic%22%3A3%7D",
    expect: "blocked",
    note: "Roku Gin 43% 700ml — bounced to /verify/traffic/error on 15 Aug",
  },
  {
    id: "roku-2",
    url: "https://shopee.sg/Roku-Japanese-Gin-700ml-i.469850887.9277155509?extraParams=%7B%22display_model_id%22%3A93394175812%2C%22model_selection_logic%22%3A3%7D",
    expect: "blocked",
    note: "Roku Japanese Gin 700ml, different seller",
  },
  {
    id: "roku-3",
    url: "https://shopee.sg/Suntory-Roku-Japanese-Gin-700ml-i.1601446.18343343065?extraParams=%7B%22display_model_id%22%3A231877137377%2C%22model_selection_logic%22%3A2%7D",
    expect: "blocked",
    note: "Suntory Roku 700ml",
  },
  {
    id: "roku-4",
    url: "https://shopee.sg/Suntory-Roku-Gin-700ml-i.1452684276.49504598629?extraParams=%7B%22display_model_id%22%3A325426050843%2C%22model_selection_logic%22%3A3%7D",
    expect: "blocked",
    note: "Suntory Roku Gin 700ml",
  },
];

/**
 * Two things to know before pointing a card at any of these.
 *
 * 1. A 700ml gin is far above the S$30 the rail can mint on one card. These links test whether the
 *    BROWSER can reach a checkout, not whether the purchase can complete. Nothing here is buyable
 *    on this rail without splitting, which is not built.
 * 2. Alcohol carries an age check in Singapore, which is one more human-only step in the way.
 */
export const SHOPIFY_LINKS: TestLink[] = [
  {
    id: "wardah",
    url: "https://wardahbooks.com",
    expect: "reachable",
    note: "Guest checkout reached live; card fields in checkout.pci.shopifyinc.com. Pickup makes the total the shelf price",
  },
  {
    id: "nylon",
    url: "https://nylon.coffee",
    expect: "reachable",
    note: "Only one gateway on the checkout, no wallet to wander into",
  },
  {
    id: "drom",
    url: "https://thelittledromstore.com",
    expect: "reachable",
    note: "Flat S$1.90 shipping. Probe sparingly — heavy probing earned a sticky Cloudflare challenge",
  },
  {
    id: "yongseng",
    url: "https://yongsengcoffee.com",
    expect: "reachable",
    note: "Cheap delivery option preselected",
  },
];

export const ALL_LINKS = [...SHOPEE_LINKS, ...SHOPIFY_LINKS];
