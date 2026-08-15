export type Category =
  | "skincare"
  | "beauty"
  | "pet"
  | "music"
  | "electronics"
  | "home"
  | "desk"
  | "other";

export type CatalogueEntry = {
  title: string;
  merchant: string;
  seller: string;
  url: string;
  amountMinor: number;
  category: Category;
  /** Words a shopper would actually use for this. Drives matching, never shown. */
  keywords: string[];
};

/**
 * Real products, discovered on real Singapore storefronts.
 *
 * Every row was opened by a browser: the URL loads, the title and price were read off the product
 * page itself, and the shop was confirmed to serve real content to an AWS datacentre IP and to
 * reach a card form at `checkout.pci.shopifyinc.com` — the cross-origin PCI iframe the Closer's
 * frame-searching filler is already proven against.
 *
 * Every price is inside S$5-30, because the StraitsX card refuses to mint outside that band and a
 * listing above it can never be bought.
 *
 * `category` matters more than it looks. Matching is category-first, because plain word overlap
 * offered "Tangle-free" earphones for an "oil-free" moisturiser — shared words are not shared
 * meaning. Categorise the PRODUCT, not the shop.
 *
 * Marketplaces are deliberately absent. Shopee, Lazada and Amazon SG refuse automated browsers,
 * and Shopee does so from a residential IP as well as from AWS — it judges the automation, not the
 * network, so nothing we control reaches them. See docs/agentcore-browser.md.
 *
 * Prices drift. A purchase failing with "merchant total exceeds approved" means the shop moved its
 * price and this file is stale — that is the total check working, not a bug.
 */
const SELLERS: Record<string, string> = {
  "cocomo.sg": "COCOMO",
  "compasia.sg": "CompAsia",
  "polypet.com.sg": "Polypet",
  "prismplus.sg": "PRISM+",
  "secretlab.sg": "Secretlab",
  "sweelee.com.sg": "Swee Lee",
};

type Row = [
  merchant: string,
  amountMinor: number,
  title: string,
  url: string,
  category: Category,
  keywords: string[],
];

const rows: Row[] = [
  ["cocomo.sg", 795, "[Mister Bower] Ready Bag", "https://www.cocomo.sg/products/mister-bower-ready-bag", "other", ["bag", "pouch", "travel", "storage"]],
  ["cocomo.sg", 910, "CLEARANCE SALE - [COSRX] One Step Green Hero Calming Pad (1 Box = 70 Pads)", "https://www.cocomo.sg/products/cosrx-one-step-green-hero-calming-pad-70-pads", "skincare", ["pad", "toner", "calming", "acne", "exfoliant", "pore", "skin", "face"]],
  ["cocomo.sg", 980, "[GONG100] Mold Remover Gel 120ml", "https://www.cocomo.sg/products/gong100-mold-remover-gel-120ml", "home", ["mold", "cleaner", "bathroom", "cleaning", "gel"]],

  ["compasia.sg", 690, "Samsung Tangle-free Earphones IN-EAR IG935 (White)", "https://compasia.sg/products/samsung-tangle-free-earphones-in-ear-ig935", "electronics", ["earphone", "headphone", "earbud", "audio", "wired"]],
  ["compasia.sg", 900, "IRIVER AT2000 Dynamic Driver in-Ear Headphones (White)", "https://compasia.sg/products/iriver-at1000-dynamic-driver-in-ear-headphones", "electronics", ["earphone", "headphone", "earbud", "audio", "wired"]],
  ["compasia.sg", 1290, "Baseus Screen Protector", "https://compasia.sg/products/it-show-event-baseus-screen-protector", "electronics", ["screen", "protector", "glass", "phone", "tempered"]],
  ["compasia.sg", 1790, "30W Fast Charging Set (Lightning)", "https://compasia.sg/products/copy-of-30w-fast-charging-set", "electronics", ["charger", "charging", "cable", "lightning", "adapter", "usb"]],

  ["polypet.com.sg", 1220, "Kong Dog AirDog Squeakair Tennis Balls M 3pcs (AST2)", "https://polypet.com.sg/products/kong-dog-airdog-squeakair-tennis-balls-m-3pcs-ast2", "pet", ["dog", "toy", "ball", "fetch", "squeaky"]],
  ["polypet.com.sg", 1880, "Go-Cat Da Bird Cat Toy with Rod", "https://polypet.com.sg/products/go-cat-da-bird-cat-toy-with-rod", "pet", ["cat", "toy", "wand", "feather", "play"]],
  ["polypet.com.sg", 1890, "Nylabone Puppy Teething Keys", "https://polypet.com.sg/products/nylabone-puppy-teething-keys", "pet", ["puppy", "dog", "chew", "teething", "toy"]],

  ["prismplus.sg", 1390, "PRISM+ Floor Cleaner — Summer Bloom 500ML", "https://prismplus.sg/products/prism-floor-cleaner", "home", ["floor", "cleaner", "cleaning", "detergent", "mop"]],
  ["prismplus.sg", 1900, "PRISM+ Dryer Aroma Capsule — 5G Fresh", "https://prismplus.sg/products/prism-dryer-aroma-capsule", "home", ["dryer", "laundry", "aroma", "fragrance", "capsule"]],
  ["prismplus.sg", 3000, "PRISM+ High Security Letterbox Lock", "https://prismplus.sg/products/prism-letterbox-lock", "home", ["lock", "security", "letterbox", "mailbox"]],

  ["secretlab.sg", 1400, "Secretlab Cable Fastening Straps (Set of 10)", "https://secretlab.sg/products/cable-fastening-straps", "desk", ["cable", "management", "strap", "tidy", "desk"]],
  ["secretlab.sg", 2400, "Secretlab Magnetic Bumpers (Set of 4)", "https://secretlab.sg/products/magnetic-bumpers", "desk", ["magnetic", "bumper", "desk", "protection"]],
  ["secretlab.sg", 2500, "Secretlab Magnetic Cable Anchors (Set of 3)", "https://secretlab.sg/products/magnetic-cable-anchors", "desk", ["cable", "anchor", "magnetic", "management", "desk"]],

  ["sweelee.com.sg", 600, "Ibanez IGC100 Micro Fiber Guitar Cloth", "https://www.sweelee.com.sg/products/ibanez-igc100-micro-fiber-guitar-cloth", "music", ["guitar", "cloth", "polish", "care"]],
  ["sweelee.com.sg", 700, "koda essential Guitar Capo ONE", "https://www.sweelee.com.sg/products/koda-essential-guitar-capo-one", "music", ["guitar", "capo", "acoustic", "electric"]],
  ["sweelee.com.sg", 1300, "D'Addario DP0002 Guitar Pro-Winder String Winder and Cutter", "https://www.sweelee.com.sg/products/d-addario-dp0002-guitar-pro-winder-string-winder-and-cutter", "music", ["guitar", "string", "winder", "cutter", "restring"]],
];

export const CATALOGUE: CatalogueEntry[] = rows.map(
  ([merchant, amountMinor, title, url, category, keywords]) => ({
    merchant,
    seller: SELLERS[merchant] ?? merchant,
    title,
    url,
    amountMinor,
    category,
    keywords,
  }),
);

export const formatSgd = (amountMinor: number) => `S$${(amountMinor / 100).toFixed(2)}`;
