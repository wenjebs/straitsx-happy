import { CATALOGUE, type CatalogueEntry, type Category, formatSgd } from "./catalogue.js";

/**
 * Picks the catalogue product that best answers a wishlist item.
 *
 * This stands in for a live search. Two failures shaped it, both seen on screen:
 *
 *   1. A stub that cycled three hardcoded listings offered an energy drink for "Cocomo Gentle
 *      Facial Cleanser". The pick had nothing to do with the request.
 *   2. Plain word overlap then offered Samsung "Tangle-free" earphones for an "oil-free"
 *      moisturiser, because both contain "free". Shared words are not shared meaning.
 *
 * So matching is category-first. A cleanser and a moisturiser are both skincare; earphones are
 * not, and no amount of incidental word overlap should bridge that. Within the right category,
 * word overlap decides which one.
 */

/** Words too common, or too generic in product copy, to carry meaning. */
const STOPWORDS = new Set([
  "a", "an", "and", "the", "for", "with", "of", "to", "in", "on", "or", "by", "from",
  "my", "your", "some", "any", "new", "best", "good", "set", "pack", "pcs", "size",
  "small", "medium", "large", "one", "two", "three", "x", "ml", "kg", "cm", "mm",
  // Marketing filler that appears on everything and matches everything.
  "free", "daily", "gentle", "soft", "light", "lightweight", "premium", "quality",
  "pro", "plus", "max", "mini", "official", "original", "sale", "clearance", "step",
  "broad", "spectrum", "type", "style", "use", "used", "value", "essential",
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

/** Singular/plural collapsed, so "balls" matches "ball" and "earphones" matches "earphone". */
const stem = (w: string) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);

/**
 * What a shopper says, mapped to what a shop writes on the box.
 *
 * People ask for "salicylic acid" and shops label it "BHA"; people ask for "benzoyl peroxide" and
 * shops sell an "acne spot gel". Without this the request lands in the right category and then
 * picks near-randomly within it — a salicylic acid treatment was answered with a moisturising
 * serum, which is skincare but not the thing.
 *
 * One-directional on purpose: expanding the REQUEST, never the product. Expanding both sides makes
 * everything match everything.
 */
const SYNONYMS: Record<string, string[]> = {
  salicylic: ["bha", "exfoliating", "acne", "pore"],
  acid: ["exfoliating"],
  benzoyl: ["acne", "spot", "blemish", "pimple"],
  peroxide: ["acne", "spot"],
  moisturizer: ["cream", "moisturizing", "hydrating", "lotion"],
  moisturiser: ["cream", "moisturizing", "hydrating", "lotion"],
  hydrating: ["moisturizing"],
  sunscreen: ["sun", "spf"],
  spf: ["sun", "sunscreen"],
  cleanser: ["cleansing", "wash", "foam"],
  wash: ["cleanser", "cleansing"],
  towel: ["cloth", "pad", "wipe"],
  tissue: ["cloth", "pad", "wipe"],
  exfoliant: ["exfoliating", "scrub", "bha"],
  headphone: ["earphone", "earbud"],
  earbud: ["earphone", "headphone"],
  charger: ["charging", "adapter"],
  leash: ["collar"],
  kibble: ["food", "treat"],
};

/** Expands a request's words with what shops actually call those things. */
function expand(words: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    for (const syn of SYNONYMS[w] ?? []) out.add(stem(syn));
  }
  return out;
}

/**
 * What kind of thing a request is for.
 *
 * Deliberately keyword-driven and readable. A model call here would be more flexible and far
 * harder to trust at a glance, and a shortlist has to be obviously sensible.
 */
const CATEGORY_HINTS: Record<Category, string[]> = {
  skincare: [
    "skincare", "skin", "face", "facial", "cleanser", "cleansing", "wash", "moisturizer",
    "moisturiser", "serum", "toner", "sunscreen", "spf", "acne", "pimple", "blemish",
    "exfoliant", "exfoliate", "salicylic", "niacinamide", "retinol", "hyaluronic", "pore",
    "blackhead", "mask", "essence", "lotion", "cream", "spot", "treatment", "routine",
  ],
  beauty: ["makeup", "lipstick", "cosmetic", "foundation", "concealer", "brush", "mascara", "beauty"],
  pet: ["pet", "dog", "puppy", "cat", "kitten", "chew", "leash", "collar", "litter", "kibble", "treat", "fetch"],
  music: ["guitar", "bass", "ukulele", "piano", "keyboard", "drum", "string", "capo", "pick", "amp", "instrument", "music", "musician"],
  electronics: [
    "phone", "charger", "charging", "cable", "usb", "adapter", "earphone", "headphone",
    "earbud", "audio", "screen", "protector", "case", "powerbank", "battery", "electronic", "device",
  ],
  home: ["home", "kitchen", "cleaning", "cleaner", "detergent", "laundry", "floor", "bathroom", "household", "lock", "storage", "dish"],
  // "management", "tidy" and "strap" live here rather than under electronics: a cable-tidy request
  // shares the word "cable" with a charging cable, and without them the tie broke by iteration
  // order and answered "cable management straps for my desk" with a phone charger.
  desk: [
    "desk", "chair", "monitor", "mousepad", "gaming", "office", "workspace", "ergonomic",
    "management", "tidy", "strap", "anchor", "riser", "mat", "clamp",
  ],
  other: [],
};

/**
 * Hints are single words on purpose. Tokenisation splits on non-letters, so a two-word hint could
 * never match anything — "cable management" sat in this table for a while matching nothing at all.
 */
export function inferCategory(text: string): Category | null {
  const words = expand(tokenize(text).map(stem));
  let best: { category: Category; hits: number } | null = null;

  for (const [category, hints] of Object.entries(CATEGORY_HINTS) as [Category, string[]][]) {
    let hits = 0;
    for (const hint of hints) if (words.has(stem(hint))) hits++;
    if (hits > 0 && (!best || hits > best.hits)) best = { category, hits };
  }
  return best?.category ?? null;
}

export type Match = {
  entry: CatalogueEntry;
  score: number;
  /** The words that earned the score, for an honest "why". */
  matched: string[];
  sameCategory: boolean;
};

export function scoreEntry(itemText: string, entry: CatalogueEntry): Match {
  const wanted = expand(tokenize(itemText).map(stem));
  const titleWords = new Set(tokenize(entry.title).map(stem));
  const keyWords = new Set(entry.keywords.map((k) => stem(k.toLowerCase())));

  let score = 0;
  const matched: string[] = [];
  for (const w of wanted) {
    // A word in the product's own title is strong evidence; one in its curated keywords is decent.
    if (titleWords.has(w)) {
      score += 3;
      matched.push(w);
    } else if (keyWords.has(w)) {
      score += 2;
      matched.push(w);
    }
  }

  const wantedCategory = inferCategory(itemText);
  const sameCategory = wantedCategory !== null && wantedCategory === entry.category;
  // Category dominates. A skincare request must not be answered with earphones however many
  // incidental words they share — "oil-free" and "tangle-free" is not a match.
  if (sameCategory) score += 10;
  else if (wantedCategory !== null && entry.category !== "other") score -= 8;

  return { entry, score, matched, sameCategory };
}

/**
 * Ranks the catalogue against one wishlist item.
 *
 * Ties break toward the cheaper product: on a card capped at S$30, headroom is worth more than a
 * marginally better word match, and a cheaper item leaves more room for shipping.
 */
export function rankCatalogue(itemText: string, pool: CatalogueEntry[] = CATALOGUE): Match[] {
  return pool
    .map((entry) => scoreEntry(itemText, entry))
    .sort((a, b) => b.score - a.score || a.entry.amountMinor - b.entry.amountMinor);
}

export type MatchedListing = {
  title: string;
  seller: string;
  rating: string;
  price: string;
  amountMinor: number;
  why: string;
  url: string;
};

const toListing = (m: Match): MatchedListing => ({
  title: m.entry.title,
  seller: m.entry.seller,
  rating: "verified listing",
  price: formatSgd(m.entry.amountMinor),
  amountMinor: m.entry.amountMinor,
  why: m.matched.length
    ? `Matched on ${[...new Set(m.matched)].slice(0, 4).join(", ")}`
    : m.sameCategory
      ? `Closest ${m.entry.category} item within the card's S$5-30 range`
      : "No close match in the catalogue — nearest available item",
  url: m.entry.url,
});

/**
 * The pick for an item, plus alternates for the "reject and re-search" path.
 *
 * `used` stops a multi-item wishlist proposing the same product twice, which reads as broken even
 * when each pick is individually defensible. It is a preference, not a rule: exhausting the right
 * category and then reaching into an unrelated one to stay unique is how a skincare list ends up
 * holding a guitar cloth, so a repeat within the category beats a fresh irrelevance.
 */
export function matchListing(
  itemText: string,
  used: Set<string> = new Set(),
): { listing: MatchedListing; alternates: MatchedListing[] } {
  const ranked = rankCatalogue(itemText);
  if (ranked.length === 0) throw new Error("catalogue is empty");

  const unused = ranked.filter((m) => !used.has(m.entry.url));
  const bestUnused = unused[0];
  const bestOverall = ranked[0];

  // Prefer an unused product, but not at the cost of leaving the right category.
  const best =
    bestUnused && (bestUnused.sameCategory || !bestOverall?.sameCategory)
      ? bestUnused
      : (bestOverall ?? bestUnused);
  if (!best) throw new Error("catalogue is empty");

  used.add(best.entry.url);
  return {
    listing: toListing(best),
    alternates: ranked.filter((m) => m.entry.url !== best.entry.url).slice(0, 2).map(toListing),
  };
}
