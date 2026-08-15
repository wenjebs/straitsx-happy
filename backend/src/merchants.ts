/**
 * The verified merchant list.
 *
 * "Verified" means someone reached a guest checkout on the live storefront and confirmed the card
 * fields render. Two rounds of that produced this list: the six shops behind `catalogue.ts`, each
 * checked from an AWS datacentre IP, and the four in docs/merchant-shortlist.md, checked by a
 * human from a residential connection. packages/closer/demo/links.ts holds the reachability
 * targets the second group came from.
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
  /*
   * The six below were verified the way that matters for this rail: each was confirmed to serve
   * real content to an AWS datacentre IP — which is exactly what an AgentCore browser egresses
   * from — and to reach a card form at checkout.pci.shopifyinc.com. They back `catalogue.ts`.
   *
   * They come first for that reason. The four after them were reached by a human from a
   * residential connection, which says nothing about whether AWS egress gets through.
   */
  {
    id: "sweelee",
    host: "sweelee.com.sg",
    name: "Swee Lee",
    origin: "https://www.sweelee.com.sg",
    sells: "musical instruments, accessories, cables, drumsticks and picks",
    shippingMinor: 0,
    probeSparingly: false,
    note: "Verified from an AWS IP. Small accessories sit inside the S$5-30 card band.",
  },
  {
    id: "cocomo",
    host: "cocomo.sg",
    name: "Cocomo",
    origin: "https://www.cocomo.sg",
    sells: "skincare, haircare and beauty",
    shippingMinor: 0,
    probeSparingly: false,
    note: "Verified from an AWS IP. Prices bundles as variants — only the default is in band.",
  },
  {
    id: "polypet",
    host: "polypet.com.sg",
    name: "Polypet",
    origin: "https://polypet.com.sg",
    sells: "pet food, treats and small pet supplies",
    shippingMinor: 0,
    probeSparingly: false,
    note: "Verified from an AWS IP.",
  },
  {
    id: "prismplus",
    host: "prismplus.sg",
    name: "PRISM+",
    origin: "https://prismplus.sg",
    sells: "consumer electronics, monitors and home appliance accessories",
    shippingMinor: 0,
    probeSparingly: false,
    note: "Verified from an AWS IP. Many products carry 30+ variants; price the default only.",
  },
  {
    id: "secretlab",
    host: "secretlab.sg",
    name: "Secretlab",
    origin: "https://secretlab.sg",
    sells: "desk and chair accessories; the chairs themselves are far above the card band",
    shippingMinor: 0,
    probeSparingly: false,
    note: "Verified from an AWS IP. Only the small accessories are buyable on this rail.",
  },
  {
    id: "compasia",
    host: "compasia.sg",
    name: "CompAsia",
    origin: "https://compasia.sg",
    sells: "refurbished phones and phone accessories",
    shippingMinor: 0,
    probeSparingly: false,
    note: "Verified from an AWS IP. Accessories only; handsets exceed S$30.",
  },
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
