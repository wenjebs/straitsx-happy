export type CatalogueEntry = {
  title: string;
  merchant: string;
  seller: string;
  url: string;
  amountMinor: number;
  /** Words that describe what this is, beyond its title. Used for matching, never shown. */
  tags: string[];
};

/**
 * Real products, discovered on real Singapore storefronts.
 *
 * Every row here was opened by a browser: the URL loads, the title and price were read off the
 * product page itself, and the shop was confirmed to serve real content to an AWS datacentre IP
 * and to reach a card form at `checkout.pci.shopifyinc.com` — the cross-origin PCI iframe the
 * Closer's frame-searching filler is already proven against.
 *
 * Every price is inside S$5-30, because the StraitsX card refuses to mint outside that band and a
 * listing above it can never be bought.
 *
 * Marketplaces are deliberately absent. Shopee, Lazada and Amazon SG refuse automated browsers,
 * and Shopee does so from a residential IP as well as from AWS — it judges the automation, not the
 * network, so nothing we control reaches them. See docs/agentcore-browser.md.
 *
 * Prices drift. If a purchase fails with "merchant total exceeds approved", the shop moved its
 * price and this file is stale — that is the total check working, not a bug.
 */
const SHOP_TAGS: Record<string, string[]> = {
  "cocomo.sg": ["skincare", "beauty", "cosmetics", "korean", "kbeauty", "face", "skin"],
  "compasia.sg": ["electronics", "phone", "mobile", "tech", "gadget", "accessory", "audio"],
  "polypet.com.sg": ["pet", "animal", "dog", "cat", "puppy", "kitten"],
  "prismplus.sg": ["home", "household", "cleaning", "appliance", "domestic"],
  "secretlab.sg": ["desk", "gaming", "setup", "office", "workspace", "accessory"],
  "sweelee.com.sg": ["music", "instrument", "guitar", "audio", "musician"],
};

const SELLERS: Record<string, string> = {
  "cocomo.sg": "COCOMO",
  "compasia.sg": "CompAsia",
  "polypet.com.sg": "Polypet",
  "prismplus.sg": "PRISM+",
  "secretlab.sg": "Secretlab",
  "sweelee.com.sg": "Swee Lee",
};

const raw: [string, number, string, string, string[]][] = [
  // merchant, amountMinor, title, url, extra tags
  ["cocomo.sg", 795, "[Mister Bower] Ready Bag", "https://www.cocomo.sg/products/mister-bower-ready-bag", ["bag", "pouch", "travel", "storage"]],
  ["cocomo.sg", 910, "CLEARANCE SALE - [COSRX] One Step Green Hero Calming Pad (1 Box = 70 Pads)", "https://www.cocomo.sg/products/cosrx-one-step-green-hero-calming-pad-70-pads", ["pad", "cleanser", "toner", "calming", "acne", "cosrx", "exfoliate"]],
  ["cocomo.sg", 980, "[GONG100] Mold Remover Gel 120ml", "https://www.cocomo.sg/products/gong100-mold-remover-gel-120ml", ["cleaning", "mold", "gel", "bathroom"]],

  ["compasia.sg", 690, "Samsung Tangle-free Earphones IN-EAR IG935 (White)", "https://compasia.sg/products/samsung-tangle-free-earphones-in-ear-ig935", ["earphones", "headphones", "earbuds", "audio", "wired"]],
  ["compasia.sg", 900, "IRIVER AT2000 Dynamic Driver in-Ear Headphones (White)", "https://compasia.sg/products/iriver-at1000-dynamic-driver-in-ear-headphones", ["earphones", "headphones", "earbuds", "audio", "wired"]],
  ["compasia.sg", 1290, "Baseus Screen Protector", "https://compasia.sg/products/it-show-event-baseus-screen-protector", ["screen", "protector", "glass", "phone", "tempered"]],
  ["compasia.sg", 1790, "30W Fast Charging Set (Lightning)", "https://compasia.sg/products/copy-of-30w-fast-charging-set", ["charger", "charging", "cable", "lightning", "adapter", "power", "usb"]],

  ["polypet.com.sg", 1220, "Kong Dog AirDog Squeakair Tennis Balls M 3pcs (AST2)", "https://polypet.com.sg/products/kong-dog-airdog-squeakair-tennis-balls-m-3pcs-ast2", ["dog", "toy", "ball", "fetch", "squeaky"]],
  ["polypet.com.sg", 1880, "Go-Cat Da Bird Cat Toy with Rod", "https://polypet.com.sg/products/go-cat-da-bird-cat-toy-with-rod", ["cat", "toy", "wand", "feather", "play"]],
  ["polypet.com.sg", 1890, "Nylabone Puppy Teething Keys", "https://polypet.com.sg/products/nylabone-puppy-teething-keys", ["puppy", "dog", "chew", "teething", "toy"]],

  ["prismplus.sg", 1390, "PRISM+ Floor Cleaner — Summer Bloom 500ML", "https://prismplus.sg/products/prism-floor-cleaner", ["floor", "cleaner", "cleaning", "detergent", "mop"]],
  ["prismplus.sg", 1900, "PRISM+ Dryer Aroma Capsule — 5G Fresh", "https://prismplus.sg/products/prism-dryer-aroma-capsule", ["dryer", "laundry", "aroma", "fragrance", "capsule"]],
  ["prismplus.sg", 3000, "PRISM+ High Security Letterbox Lock", "https://prismplus.sg/products/prism-letterbox-lock", ["lock", "security", "letterbox", "mailbox"]],

  ["secretlab.sg", 1400, "Secretlab Cable Fastening Straps (Set of 10)", "https://secretlab.sg/products/cable-fastening-straps", ["cable", "management", "straps", "tidy", "velcro"]],
  ["secretlab.sg", 2400, "Secretlab Magnetic Bumpers (Set of 4)", "https://secretlab.sg/products/magnetic-bumpers", ["magnetic", "bumper", "desk", "protection"]],
  ["secretlab.sg", 2500, "Secretlab Magnetic Cable Anchors (Set of 3)", "https://secretlab.sg/products/magnetic-cable-anchors", ["cable", "anchor", "magnetic", "management", "tidy"]],

  ["sweelee.com.sg", 600, "Ibanez IGC100 Micro Fiber Guitar Cloth", "https://www.sweelee.com.sg/products/ibanez-igc100-micro-fiber-guitar-cloth", ["guitar", "cloth", "polish", "care", "cleaning"]],
  ["sweelee.com.sg", 700, "koda essential Guitar Capo ONE", "https://www.sweelee.com.sg/products/koda-essential-guitar-capo-one", ["guitar", "capo", "acoustic", "electric"]],
  ["sweelee.com.sg", 1300, "D'Addario DP0002 Guitar Pro-Winder String Winder and Cutter", "https://www.sweelee.com.sg/products/d-addario-dp0002-guitar-pro-winder-string-winder-and-cutter", ["guitar", "string", "winder", "cutter", "tool", "restring"]],
];

export const CATALOGUE: CatalogueEntry[] = raw.map(([merchant, amountMinor, title, url, extra]) => ({
  merchant,
  seller: SELLERS[merchant] ?? merchant,
  title,
  url,
  amountMinor,
  tags: [...(SHOP_TAGS[merchant] ?? []), ...extra],
}));

export const formatSgd = (amountMinor: number) => `S$${(amountMinor / 100).toFixed(2)}`;
