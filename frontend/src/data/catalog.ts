/*
 * Every piece of dummy content in the prototype, in one place.
 *
 * In production each export here becomes an API response: `ITEMS` is the
 * activity's wishlist, `LISTINGS` / `ALTERNATES` are agent search results,
 * `ARCHIVE` is the activity history. The shapes are what the UI renders, so
 * they are the contract worth keeping when the server arrives.
 */

export type ItemId = "gpu" | "cpu" | "mb" | "ram" | "psu" | "case";

/** The five stops an agent moves between. Index doubles as track position. */
export const STAGES = ["Discovering", "Analyzing", "Gathering", "Comparing", "Selected"] as const;
export type StageIndex = 0 | 1 | 2 | 3 | 4;

export interface Item {
  id: ItemId;
  name: string;
  short: string;
  spec: string;
  budget: string;
  /** Identity hue token. Owns this item's dot, tiles, chips and fills. */
  hue: string;
  /** Tick at which this item's agents are dispatched; before it, queued. */
  start: number;
  /**
   * Stage index per tick. Authored per item so the screen shows a mix of
   * stages and three distinct backward loops (Gathering -> Discovering).
   * Real agents genuinely revisit earlier stages, so keep the concept when
   * these become server-pushed events.
   */
  path: number[];
}

export const ITEMS: readonly Item[] = [
  {
    id: "gpu",
    name: "Graphics card",
    short: "GPU",
    spec: "RTX 4060 class, 8GB",
    budget: "S$430",
    hue: "var(--hue-0)",
    start: 0,
    path: [0, 1, 2, 0, 1, 2, 3, 4],
  },
  {
    id: "cpu",
    name: "Processor",
    short: "CPU",
    spec: "Ryzen 5 / Core i5, 6 cores",
    budget: "S$285",
    hue: "var(--hue-1)",
    start: 0,
    path: [0, 1, 2, 3, 3, 4],
  },
  {
    id: "mb",
    name: "Motherboard",
    short: "MB",
    spec: "B650 mATX, DDR5",
    budget: "S$205",
    hue: "var(--hue-2)",
    start: 1,
    path: [0, 0, 1, 2, 0, 1, 2, 3, 4],
  },
  {
    id: "ram",
    name: "Memory",
    short: "RAM",
    spec: "16GB DDR5-6000 kit",
    budget: "S$120",
    hue: "var(--hue-3)",
    start: 0,
    path: [0, 1, 1, 2, 3, 4],
  },
  {
    id: "psu",
    name: "Power supply",
    short: "PSU",
    spec: "650W 80+ Gold",
    budget: "S$135",
    hue: "var(--hue-4)",
    start: 2,
    path: [0, 1, 2, 2, 3, 4],
  },
  {
    id: "case",
    name: "Case",
    short: "CASE",
    spec: "mATX airflow, mesh front",
    budget: "S$110",
    hue: "var(--hue-5)",
    start: 1,
    path: [0, 1, 2, 0, 0, 1, 2, 3, 4],
  },
];

export interface Listing {
  title: string;
  seller: string;
  rating: string;
  price: string;
  /** Price in whole dollars, for totals and the wallet debit. */
  amount: number;
  why: string;
}

export const LISTINGS: Record<ItemId, Listing> = {
  gpu: {
    title: "ASUS Dual RTX 4060 OC 8GB",
    seller: "Bizgram Asia",
    rating: "4.8 · 1,204 reviews",
    price: "S$429.00",
    amount: 429,
    why: "Cheapest in-stock 4060 from a seller with a local RMA counter.",
  },
  cpu: {
    title: "AMD Ryzen 5 7600 (boxed)",
    seller: "Dynacore Sim Lim Sq.",
    rating: "4.9 · 863 reviews",
    price: "S$279.00",
    amount: 279,
    why: "Boxed cooler included, S$18 under the next listing.",
  },
  mb: {
    title: "MSI PRO B650M-A WiFi",
    seller: "Bizgram Asia",
    rating: "4.7 · 512 reviews",
    price: "S$199.00",
    amount: 199,
    why: "Only mATX B650 under S$210 with WiFi 6E and 4 DIMM slots.",
  },
  ram: {
    title: "Kingston Fury Beast 16GB DDR5-6000",
    seller: "Shopee · TechDeals.SG",
    rating: "4.8 · 3,417 reviews",
    price: "S$112.00",
    amount: 112,
    why: "EXPO profile matches the board QVL; 12-month local warranty.",
  },
  psu: {
    title: "Cooler Master MWE Gold 650 V2",
    seller: "Lazada · CM Official",
    rating: "4.9 · 2,088 reviews",
    price: "S$129.00",
    amount: 129,
    why: "Fully modular at the price of the semi-modular rivals.",
  },
  case: {
    title: "Lian Li Lancool 205M Mesh",
    seller: "Bizgram Asia",
    rating: "4.6 · 741 reviews",
    price: "S$105.00",
    amount: 105,
    why: "Two 140mm intakes stock, clears the Dual 4060 by 40mm.",
  },
};

/** Swapped in when a shortlist pick is rejected and its agents go back out. */
export const ALTERNATES: Partial<Record<ItemId, Listing>> = {
  gpu: {
    title: "Gigabyte RTX 4060 WINDFORCE OC",
    seller: "Lazada · Gigabyte Store",
    rating: "4.7 · 968 reviews",
    price: "S$449.00",
    amount: 449,
    why: "Re-searched pick: quieter cooler, S$20 more.",
  },
  cpu: {
    title: "Intel Core i5-13400F",
    seller: "Bizgram Asia",
    rating: "4.8 · 1,102 reviews",
    price: "S$268.00",
    amount: 268,
    why: "Re-searched pick: cheaper, needs an aftermarket cooler.",
  },
};

export interface CuratorOption {
  name: string;
  range: string;
  why: string;
  imgLabel: string;
}

/** Only ambiguous items get a clarification card; the rest are spec-bound. */
export const CURATOR: Partial<Record<ItemId, readonly CuratorOption[]>> = {
  gpu: [
    {
      name: "RTX 4060 8GB",
      range: "S$399 – S$489",
      why: "Best 1080p per dollar with DLSS 3 and low power draw.",
      imgLabel: "gpu · 4060",
    },
    {
      name: "RX 7600 8GB",
      range: "S$359 – S$429",
      why: "Cheaper raster, weaker ray tracing and upscaling.",
      imgLabel: "gpu · 7600",
    },
    {
      name: "Arc B580 12GB",
      range: "S$379 – S$419",
      why: "More VRAM, driver maturity still uneven on older titles.",
      imgLabel: "gpu · b580",
    },
  ],
  case: [
    {
      name: "mATX mesh airflow",
      range: "S$95 – S$135",
      why: "Coolest option; front mesh trades some fan noise damping.",
      imgLabel: "case · mesh",
    },
    {
      name: "mATX tempered glass",
      range: "S$105 – S$159",
      why: "Looks better on a desk, runs 3–5°C warmer.",
      imgLabel: "case · glass",
    },
    {
      name: "Compact ITX-style",
      range: "S$139 – S$189",
      why: "Small footprint, tight GPU clearance for a 2-slot card.",
      imgLabel: "case · sff",
    },
  ],
};

/** The page each agent is working. The trailing second agent appends `?p=2`. */
export const AGENT_HOSTS: Record<ItemId, string> = {
  gpu: "bizgram.com.sg/rtx-4060",
  cpu: "dynacore.com.sg/ryzen-7600",
  mb: "sim-lim.sg/b650m",
  ram: "shopee.sg/kingston-fury",
  psu: "lazada.sg/mwe-650-v2",
  case: "bizgram.com.sg/lancool-205m",
};

/** What an agent is doing, by the stage it currently sits at. */
export const STAGE_ACTIONS = [
  "crawling listing pages",
  "reading spec table",
  "pulling seller history",
  "diffing 6 candidates",
  "locked candidate",
] as const;

export const EXEC_STEPS = [
  "requesting card",
  "entering checkout",
  "confirming order",
  "order confirmed",
] as const;

export type ArchiveId = "pantry" | "desk" | "gift" | "lens";

export interface ArchivedActivity {
  title: string;
  ts: string;
  total: string;
  state: "completed" | "cancelled";
  /** Chevron fill fraction: 1 completed, 0.45 stopped at shortlist. */
  frac: number;
  lines: readonly { name: string; seller: string; price: string }[];
}

export const ARCHIVE: Record<ArchiveId, ArchivedActivity> = {
  pantry: {
    title: "Restock pantry — 12 items",
    ts: "12 Aug 2026 · 09:22",
    total: "S$186.40",
    state: "completed",
    frac: 1,
    lines: [
      { name: "Jasmine rice 5kg", seller: "FairPrice Online", price: "S$14.90" },
      { name: "Kikkoman soy sauce 1L", seller: "Redmart", price: "S$9.20" },
      { name: "Milo refill 1.8kg", seller: "FairPrice Online", price: "S$21.50" },
      { name: "Olive oil 750ml", seller: "Redmart", price: "S$18.80" },
      { name: "+ 8 more items", seller: "mixed sellers", price: "S$122.00" },
    ],
  },
  desk: {
    title: "Standing desk under S$700",
    ts: "09 Aug 2026 · 17:48",
    total: "S$649.00",
    state: "completed",
    frac: 1,
    lines: [{ name: "Ergotune Sit-Stand Pro 140cm", seller: "Ergotune SG", price: "S$649.00" }],
  },
  gift: {
    title: "Birthday gift for Mei",
    ts: "04 Aug 2026 · 11:02",
    total: "S$0.00",
    state: "cancelled",
    frac: 0.45,
    lines: [
      { name: "Cancelled at shortlist — nothing under cap", seller: "no seller", price: "S$0.00" },
    ],
  },
  lens: {
    title: "Monthly contact lenses",
    ts: "28 Jul 2026 · 20:15",
    total: "S$96.00",
    state: "completed",
    frac: 1,
    lines: [
      { name: "Acuvue Oasys 6-pack ×2", seller: "Lazada · Acuvue Official", price: "S$96.00" },
    ],
  },
};

export const PAST_ACTIVITIES = [
  { id: "pantry", title: "Restock pantry — 12 items", state: "completed", ts: "Aug 12", frac: 1 },
  { id: "desk", title: "Standing desk under S$700", state: "completed", ts: "Aug 09", frac: 1 },
  { id: "gift", title: "Birthday gift for Mei", state: "cancelled", ts: "Aug 04", frac: 0.45 },
  { id: "lens", title: "Monthly contact lenses", state: "completed", ts: "Jul 28", frac: 1 },
] as const satisfies readonly {
  id: ArchiveId;
  title: string;
  state: "completed" | "cancelled";
  ts: string;
  frac: number;
}[];

/** Status lifecycle: issued -> viewed -> used -> expired. */
export type CardStatus = "issued" | "viewed" | "used" | "expired";

export const DISPOSABLE_CARDS: readonly { pan: string; amount: string; status: CardStatus }[] = [
  { pan: "4319 •••• 4402", amount: "S$429.00", status: "used" },
  { pan: "4319 •••• 4398", amount: "S$279.00", status: "used" },
  { pan: "4319 •••• 4386", amount: "S$120.00", status: "expired" },
  { pan: "4319 •••• 4371", amount: "S$689.00", status: "issued" },
  { pan: "4319 •••• 4355", amount: "S$42.60", status: "viewed" },
];

export const TRANSACTIONS: readonly {
  ts: string;
  label: string;
  ref: string;
  amount: string;
  debit: boolean;
}[] = [
  {
    ts: "15 Aug · 14:33",
    label: "Card authorisation · Bizgram Asia",
    ref: "auth 4402",
    amount: "−S$429.00",
    debit: true,
  },
  {
    ts: "15 Aug · 14:10",
    label: "Top-up from DBS ••4471",
    ref: "0x4c…9ae1",
    amount: "+S$500.00",
    debit: false,
  },
  {
    ts: "12 Aug · 09:22",
    label: "Pantry restock · 12 items",
    ref: "act 0f31",
    amount: "−S$186.40",
    debit: true,
  },
  {
    ts: "09 Aug · 17:48",
    label: "Standing desk · Ergotune",
    ref: "auth 4310",
    amount: "−S$649.00",
    debit: true,
  },
  {
    ts: "04 Aug · 11:02",
    label: "Refund · cancelled activity",
    ref: "act 0e88",
    amount: "+S$78.00",
    debit: false,
  },
  {
    ts: "28 Jul · 20:15",
    label: "Contact lenses · Lazada",
    ref: "auth 4288",
    amount: "−S$96.00",
    debit: true,
  },
];

export const PROFILE_ROWS: readonly { k: string; v: string }[] = [
  { k: "Name", v: "Tricia Lim" },
  { k: "Email", v: "tricia.lim@hey.sg" },
  { k: "Linked wallet", v: "0x8f41c2ba9d7e5f30a6b1d4c9e2f7a8b0c14b" },
  { k: "Wallet network", v: "Polygon · XSGD" },
  { k: "Passkey", v: "MacBook Pro · added 12 Jun 2026" },
  { k: "Agent identity", v: "happy-agent/1.4 (tricia-lim)" },
];

export const SUGGESTIONS = [
  "build me a budget gaming PC under S$1,600",
  "restock my pantry, same brands as last month",
  "here is a list of 8 things for a new apartment",
] as const;

export const ACTIVITY_TITLE = "Budget gaming PC build";

export function money(n: number): string {
  return `S$${n.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
