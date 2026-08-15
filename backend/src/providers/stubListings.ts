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
 * These are real Shopee listings for Suntory Roku gin. Two things about them are measured, not
 * guessed, and both mean a run against these will fail — visibly and for a stated reason, which is
 * the point of having them:
 *
 *   1. Shopee blocks us. From an AWS datacentre IP these URLs return Shopee's "Page Unavailable"
 *      page — served AT the product URL rather than as a redirect, so a URL check alone reports
 *      success. Only a screenshot or a content check catches it. There is no captcha to solve, so
 *      the human-takeover path cannot rescue it either. See docs/agentcore-browser.md.
 *
 *   2. The price is above the card's ceiling. Roku 700ml sells around S$68-88, and the card cannot
 *      mint above S$30, so `issueCard` refuses with an HTTP 400 before a browser is ever opened.
 *
 * `overCardCeiling` marks the second problem explicitly so nobody spends an evening debugging a
 * purchase that was never going to be authorised.
 */
export const STUB_LISTINGS: StubListing[] = [
  {
    title: "Suntory Roku Gin 700ml",
    seller: "Shopee",
    rating: "4.9",
    price: "S$78.00",
    amountMinor: 7800,
    why: "Japanese craft gin, 700ml as specified",
    url: "https://shopee.sg/Suntory-Roku-Gin-700ml-i.1452684276.49504598629?extraParams=%7B%22display_model_id%22%3A325426050843%2C%22model_selection_logic%22%3A3%7D",
  },
  {
    title: "Suntory Roku Japanese Gin 700ml",
    seller: "Shopee",
    rating: "4.8",
    price: "S$72.00",
    amountMinor: 7200,
    why: "Same product, different seller — cheaper",
    url: "https://shopee.sg/Suntory-Roku-Japanese-Gin-700ml-i.1601446.18343343065?extraParams=%7B%22display_model_id%22%3A231877137377%2C%22model_selection_logic%22%3A2%7D",
  },
  {
    title: "Roku Japanese Gin 700ml",
    seller: "Shopee",
    rating: "4.7",
    price: "S$69.00",
    amountMinor: 6900,
    why: "Lowest listed price for the same bottle",
    url: "https://shopee.sg/Roku-Japanese-Gin-700ml-i.469850887.9277155509?extraParams=%7B%22display_model_id%22%3A93394175812%2C%22model_selection_logic%22%3A3%7D",
  },
];

/** Listings the card cannot pay for. Non-empty here is a known limitation, not a bug. */
export const overCardCeiling = (): StubListing[] =>
  STUB_LISTINGS.filter((l) => l.amountMinor > CARD_MAX_MINOR);
