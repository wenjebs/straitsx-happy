/**
 * The verified merchant list.
 *
 * "Verified" means a human reached a guest checkout on the live storefront and confirmed the card
 * fields render — see docs/merchant-shortlist.md for the walkthrough of each one, and
 * packages/closer/demo/links.ts for the browser-reachability test targets they came from.
 *
 * Everything here is Shopify. That is not a coincidence: a Shopify storefront exposes a stable
 * `/search` and a per-product `.js` document, so a scout can read an exact price in cents rather
 * than parsing a rendered string. Marketplaces (Shopee, Lazada, Amazon.sg, FairPrice, COURTS) are
 * deliberately excluded — they bounce datacentre egress, or demand an account and a phone OTP.
 *
 * Scouts only ever visit hosts in this list. A listing from anywhere else cannot be shortlisted,
 * and would be denied at `rules.ts` anyway when it is not in the mandate's `merchants`.
 */
export interface VerifiedMerchant {
  id: string;
  /** Bare hostname. This is what goes in a mandate's `merchants` allowlist. */
  host: string;
  name: string;
  origin: string;
  /** What the storefront sells, used to steer a scout away from pointless searches. */
  sells: string;
  /** Flat delivery cost in cents, so a scout can keep the all-in total inside the card bounds. */
  shippingMinor: number;
  /**
   * Cloudflare has previously challenged this host under heavy probing. Scouts visit it last and
   * only when nothing cheaper has matched.
   */
  probeSparingly: boolean;
  note: string;
}

export const VERIFIED_MERCHANTS: VerifiedMerchant[] = [
  {
    id: "wardah",
    host: "wardahbooks.com",
    name: "Wardah Books",
    origin: "https://wardahbooks.com",
    sells: "books, mostly literature, history and Islamic studies",
    shippingMinor: 0,
    probeSparingly: false,
    note: "Local pickup at 58 Bussorah Street makes the total the shelf price. Card fields live in checkout.pci.shopifyinc.com.",
  },
  {
    id: "nylon",
    host: "nylon.coffee",
    name: "Nylon Coffee Roasters",
    origin: "https://nylon.coffee",
    sells: "specialty coffee beans, filters and brewing accessories",
    shippingMinor: 380,
    probeSparingly: false,
    note: "One gateway on the checkout and no wallet tile to wander into.",
  },
  {
    id: "yongseng",
    host: "yongsengcoffee.com",
    name: "Yong Seng Coffee",
    origin: "https://yongsengcoffee.com",
    sells: "traditional kopi powder, tea and local drink supplies",
    shippingMinor: 470,
    probeSparingly: false,
    note: "A cheap delivery option is preselected.",
  },
  {
    id: "drom",
    host: "thelittledromstore.com",
    name: "the little dröm store",
    origin: "https://thelittledromstore.com",
    sells: "stationery, desk goods and small design objects",
    shippingMinor: 190,
    probeSparingly: true,
    note: "Flat S$1.90 shipping. Heavy probing has earned a sticky Cloudflare challenge before.",
  },
];

export function merchantById(id: string): VerifiedMerchant | undefined {
  return VERIFIED_MERCHANTS.find((merchant) => merchant.id === id);
}

export function isVerifiedHost(host: string): boolean {
  const bare = host.replace(/^www\./, "").toLowerCase();
  return VERIFIED_MERCHANTS.some((merchant) => merchant.host === bare);
}

/**
 * Scouts are split across the list rather than all racing the same storefront, so two slots on the
 * same item cover four merchants between them and the tiles show different pages.
 */
export function merchantsForSlot(slot: number, slots: number): VerifiedMerchant[] {
  const ordered = [...VERIFIED_MERCHANTS].sort((a, b) =>
    a.probeSparingly === b.probeSparingly ? 0 : a.probeSparingly ? 1 : -1,
  );
  return ordered.filter((_, index) => index % slots === slot % slots);
}
