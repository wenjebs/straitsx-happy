export type StubListing = {
  title: string;
  seller: string;
  rating: string;
  price: string;
  amountMinor: number;
  why: string;
  url: string;
};

/** The StraitsX card mints between S$5 and S$30. Outside that, issuance is refused with a 400. */
export const CARD_MIN_MINOR = 500;
export const CARD_MAX_MINOR = 3000;

/**
 * Fixed listings, standing in for discovery.
 *
 * Real Shopee listings, all priced inside the card's S$5-30 band so `issueCard` accepts them —
 * an earlier set of gin listings at S$69-78 was refused by the payment rail before a browser ever
 * opened, which is the range check doing its job.
 *
 * The prices below are estimates. They could not be read from the pages, because Shopee refuses
 * automated browsers: `probe/shopee-prices.ts` loads these URLs from a local Playwright browser on
 * a residential connection and gets `/verify/traffic/error` — the same bounce AgentCore gets, on an
 * IP where a hand-driven browser opens them fine. So the block is on the automation, not the
 * network, and no proxy or datacentre change fixes it.
 *
 * That has a consequence worth stating: a run against these reaches the Closer, opens a browser and
 * fails at Shopee's block. It will not reach the merchant total check, so the estimated prices are
 * never actually compared against a page. Point SCOUT_LISTINGS at demo-store for a run that
 * completes.
 */
export const STUB_LISTINGS: StubListing[] = [
  {
    title: "Red Bull Kratingdaeng Energy Drink 250ml, 24 cans",
    seller: "Shopee",
    rating: "4.9",
    price: "S$28.00",
    amountMinor: 2800,
    why: "Thailand original, case of 24 — near the card ceiling but inside it",
    url: "https://shopee.sg/Red-Bull-Kratingdaeng-Energy-Drink-250ml-Cans-Set-of-24-(Thailand-Origin)-i.1840063679.47111344816?extraParams=%7B%22display_model_id%22%3A360986618387%2C%22model_selection_logic%22%3A3%7D",
  },
  {
    title: "COSRX Salicylic Acid Daily Gentle Cleanser 150ml",
    seller: "Shopee",
    rating: "4.8",
    price: "S$14.00",
    amountMinor: 1400,
    why: "BHA cleanser for acne-prone skin, official store",
    url: "https://shopee.sg/-COSRX-OFFICIAL-Salicylic-Acid-Daily-Gentle-Cleanser-150ml-Salicylic-Acid-0.5-Tea-Tree-Leaf-Oil-0.2-Acne-Treatment-Cleanser-for-Acne-prone-Skin-BHA-Cleanser-i.116704504.1933154709?extraParams=%7B%22display_model_id%22%3A41877311728%2C%22model_selection_logic%22%3A3%7D",
  },
  {
    title: "IUIGA 1.8L Glass Baking Dish",
    seller: "Shopee",
    rating: "4.7",
    price: "S$19.00",
    amountMinor: 1900,
    why: "Heat resistant, oven and microwave safe, detachable handles",
    url: "https://shopee.sg/IUIGA-1.8L-Glass-Baking-Dish-Heat-Resistant-Oven-Microwave-Safe-Casserole-Roasting-Pan-with-Detachable-Handles-i.1250897527.40532646220?extraParams=%7B%22display_model_id%22%3A272789102721%2C%22model_selection_logic%22%3A3%7D",
  },
];

/** Listings the card cannot pay for. Non-empty here is a known limitation, not a bug. */
export const overCardCeiling = (): StubListing[] =>
  STUB_LISTINGS.filter((l) => l.amountMinor > CARD_MAX_MINOR);
