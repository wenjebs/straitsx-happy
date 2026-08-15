export type StubListing = {
  title: string;
  seller: string;
  rating: string;
  price: string;
  amountMinor: number;
  why: string;
  url: string;
};

/**
 * Fixed listings, standing in for discovery.
 *
 * What each merchant actually does from an AWS datacentre IP was measured, not guessed — see
 * `docs/agentcore-browser.md`. It is recorded here so nobody reads a purchase.failed from Shopee
 * as a defect in the Closer:
 *
 *   Lazada — an intermittent slider captcha. A human clears it in the live view and the run
 *            continues with cookies intact. This is the human-takeover path working, and it is the
 *            reason these listings are worth having.
 *
 *   Shopee — a hard bounce to /verify/traffic/error with is_logged_in=false. There is no challenge
 *            to solve, so takeover cannot rescue it and these listings will report
 *            purchase.failed at the first step. The lever for that case is proxyConfiguration on
 *            StartBrowserSession, which is untested.
 *
 * Every price sits inside the S$5–30 the StraitsX card can mint; outside that range issuance is
 * refused with an HTTP 400 before a browser is ever opened.
 */
export const STUB_LISTINGS: StubListing[] = [
  {
    title: "Anker 100W USB-C Cable 2m",
    seller: "Lazada",
    rating: "4.8",
    price: "S$18.90",
    amountMinor: 1890,
    why: "Matches the specification and clears a captcha a human can solve",
    url: "https://www.lazada.sg/products/anker-100w-usb-c-cable-i1234567890.html",
  },
  {
    title: "Logitech M240 Wireless Mouse",
    seller: "Lazada",
    rating: "4.7",
    price: "S$24.90",
    amountMinor: 2490,
    why: "Well within the card's S$30 ceiling",
    url: "https://www.lazada.sg/products/logitech-m240-wireless-mouse-i2234567890.html",
  },
  {
    title: "Xiaomi Mi Band Strap",
    seller: "Lazada",
    rating: "4.5",
    price: "S$8.50",
    amountMinor: 850,
    why: "Cheap enough to rehearse with, still above the S$5 card floor",
    url: "https://www.lazada.sg/products/xiaomi-mi-band-strap-i3234567890.html",
  },
  {
    title: "USB-C to USB-C Cable 100W 2m",
    seller: "Shopee",
    rating: "4.9",
    price: "S$16.90",
    amountMinor: 1690,
    why: "Matches the specification — expect a traffic bounce, not a checkout",
    url: "https://shopee.sg/product/123456789/1234567890",
  },
  {
    title: "Baseus 65W GaN Charger",
    seller: "Shopee",
    rating: "4.8",
    price: "S$28.00",
    amountMinor: 2800,
    why: "Near the S$30 ceiling — expect a traffic bounce, not a checkout",
    url: "https://shopee.sg/product/223456789/2234567890",
  },
];
