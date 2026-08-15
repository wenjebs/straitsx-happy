import { describe, expect, it } from "vitest";
import { CATALOGUE } from "./providers/catalogue.js";
import { inferCategory, matchListing, rankCatalogue } from "./providers/matchListing.js";

describe("catalogue", () => {
  // Outside S$5-30 the card refuses to mint, so a listing there can never be bought.
  it("prices every entry inside the card's mint bounds", () => {
    for (const e of CATALOGUE) {
      expect(e.amountMinor).toBeGreaterThanOrEqual(500);
      expect(e.amountMinor).toBeLessThanOrEqual(3000);
    }
  });

  it("uses https urls and no marketplaces", () => {
    for (const e of CATALOGUE) {
      const url = new URL(e.url);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).not.toMatch(/shopee|lazada|amazon/i);
    }
  });

  it("spans several merchants, so one shop going down does not kill the demo", () => {
    expect(new Set(CATALOGUE.map((e) => e.merchant)).size).toBeGreaterThanOrEqual(4);
  });
});

describe("matching a wishlist item to a product", () => {
  /*
   * The regression this whole module exists for: the previous stub handed every item the same
   * three hardcoded listings, so a facial cleanser was answered with an energy drink.
   */
  it("answers a skincare item with skincare, not something unrelated", () => {
    const { listing } = matchListing("Cocomo gentle facial cleanser for daily face wash");
    expect(listing.url).toContain("cocomo.sg");
  });

  it("answers a dog toy with a dog product", () => {
    const { listing } = matchListing("a chew toy for my puppy");
    expect(listing.url).toContain("polypet");
    expect(listing.title.toLowerCase()).toMatch(/puppy|dog|teething|chew/);
  });

  it("answers a guitar accessory from the music shop", () => {
    const { listing } = matchListing("guitar capo for acoustic guitar");
    expect(listing.url).toContain("sweelee");
    expect(listing.title.toLowerCase()).toContain("capo");
  });

  it("answers earphones with earphones", () => {
    const { listing } = matchListing("cheap wired in-ear earphones");
    expect(listing.title.toLowerCase()).toMatch(/earphone|headphone/);
  });

  it("answers a cable-tidy request from the desk shop", () => {
    const { listing } = matchListing("cable management straps to tidy my desk");
    expect(listing.url).toContain("secretlab");
    expect(listing.title.toLowerCase()).toContain("cable");
  });

  it("explains itself with the words it actually matched", () => {
    const { listing } = matchListing("guitar capo");
    expect(listing.why).toMatch(/matched on/i);
    expect(listing.why.toLowerCase()).toContain("capo");
  });

  it("breaks ties toward the cheaper product, since the card caps at S$30", () => {
    const ranked = rankCatalogue("guitar");
    const top = ranked.filter((m) => m.score === ranked[0]?.score);
    if (top.length > 1) {
      expect(top[0]?.entry.amountMinor).toBeLessThanOrEqual(top[1]?.entry.amountMinor ?? 0);
    }
  });

  it("does not propose the same product twice across a wishlist", () => {
    const used = new Set<string>();
    const a = matchListing("guitar capo", used);
    const b = matchListing("guitar capo", used);
    expect(b.listing.url).not.toBe(a.listing.url);
  });

  it("still returns something for a request nothing matches, and says so", () => {
    const { listing } = matchListing("a zeppelin");
    expect(listing.url).toMatch(/^https:/);
    expect(listing.why).toMatch(/no close match|closest/i);
  });

  /*
   * The second regression: plain word overlap offered Samsung "Tangle-free" earphones for an
   * "oil-free" moisturiser, because both contain "free". Shared words are not shared meaning.
   */
  it("does not answer skincare with electronics over an incidental shared word", () => {
    const { listing } = matchListing("Lightweight oil-free moisturizer for the face");
    expect(listing.url).not.toContain("compasia");
    expect(listing.title.toLowerCase()).not.toMatch(/earphone|headphone/);
  });

  it("keeps a whole skincare wishlist inside skincare", () => {
    const used = new Set<string>();
    const items = [
      "Gentle foaming cleanser",
      "Lightweight oil-free moisturizer",
      "Salicylic acid acne treatment",
    ];
    for (const item of items) {
      const { listing } = matchListing(item, used);
      expect(listing.url).not.toMatch(/sweelee|polypet|secretlab/);
    }
  });

  it("infers the category a request is about", () => {
    expect(inferCategory("gentle foaming face cleanser")).toBe("skincare");
    expect(inferCategory("chew toy for my puppy")).toBe("pet");
    expect(inferCategory("guitar capo")).toBe("music");
    expect(inferCategory("usb-c charging cable")).toBe("electronics");
  });

  /*
   * A request lands in the right category and then has to pick within it. Shoppers say
   * "salicylic acid"; shops write "BHA". Without synonyms the pick was near-random inside
   * skincare — a salicylic acid treatment was answered with a moisturising serum.
   */
  it("maps what a shopper says to what a shop writes on the box", () => {
    expect(matchListing("salicylic acid treatment 2%").listing.title.toLowerCase()).toMatch(
      /bha|exfoliat|acne|pore/,
    );
    expect(matchListing("benzoyl peroxide spot treatment").listing.title.toLowerCase()).toMatch(
      /acne|spot|clean/,
    );
    expect(matchListing("lightweight oil-free moisturizer").listing.title.toLowerCase()).toMatch(
      /cream|moistur|lotion/,
    );
  });

  it("offers alternates for the reject-and-re-search path", () => {
    const { alternates } = matchListing("guitar");
    expect(alternates.length).toBeGreaterThan(0);
  });
});
