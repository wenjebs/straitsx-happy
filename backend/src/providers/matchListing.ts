import { CATALOGUE, type CatalogueEntry, formatSgd } from "./catalogue.js";

/**
 * Picks the catalogue product that best answers a wishlist item.
 *
 * This stands in for a real search. It exists because the alternative — handing every wishlist item
 * the same three hardcoded listings — produced a shortlist that offered an energy drink for
 * "Cocomo Gentle Facial Cleanser", which is worse than no discovery at all: a plausible-looking
 * shortlist nobody can trust.
 *
 * The scoring is deliberately dull. Overlapping words between what the user asked for and what a
 * product is, weighted so a hit in the title counts for more than a hit in a shop's category. No
 * embeddings, no model call: a demo needs a shortlist that is obviously sensible, and a dull
 * scorer that can be read in ten seconds is easier to trust than one that cannot.
 */

/** Words too common to carry meaning. Matching on "the" or "for" produces noise, not relevance. */
const STOPWORDS = new Set([
  "a", "an", "and", "the", "for", "with", "of", "to", "in", "on", "or", "by", "from",
  "my", "your", "some", "any", "new", "best", "good", "set", "pack", "pcs", "size",
  "small", "medium", "large", "one", "two", "x", "ml", "g", "kg", "cm", "mm",
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

/** Singular/plural collapsed, so "balls" matches "ball" and "earphones" matches "earphone". */
const stem = (w: string) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);

export type Match = {
  entry: CatalogueEntry;
  score: number;
  /** The words that earned the score, for an honest "why". */
  matched: string[];
};

export function scoreEntry(itemText: string, entry: CatalogueEntry): Match {
  const wanted = new Set(tokenize(itemText).map(stem));
  const titleWords = new Set(tokenize(entry.title).map(stem));
  const tagWords = new Set(entry.tags.map((t) => stem(t.toLowerCase())));

  let score = 0;
  const matched: string[] = [];
  for (const w of wanted) {
    // A word in the product's own title is strong evidence; a word describing its shop is weak.
    if (titleWords.has(w)) {
      score += 3;
      matched.push(w);
    } else if (tagWords.has(w)) {
      score += 1;
      matched.push(w);
    }
  }
  return { entry, score, matched };
}

/**
 * Ranks the whole catalogue against one wishlist item.
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
    : "Closest available item within the card's S$5-30 range",
  url: m.entry.url,
});

/**
 * The pick for an item, plus alternates for the "reject and re-search" path.
 *
 * `used` lets a multi-item wishlist avoid proposing the same product twice, which reads as broken
 * even when each pick is individually defensible.
 */
export function matchListing(
  itemText: string,
  used: Set<string> = new Set(),
): { listing: MatchedListing; alternates: MatchedListing[] } {
  const ranked = rankCatalogue(itemText);
  const fresh = ranked.filter((m) => !used.has(m.entry.url));
  const pool = fresh.length > 0 ? fresh : ranked;

  const best = pool[0];
  if (!best) throw new Error("catalogue is empty");
  used.add(best.entry.url);

  return {
    listing: toListing(best),
    alternates: pool.slice(1, 3).map(toListing),
  };
}
