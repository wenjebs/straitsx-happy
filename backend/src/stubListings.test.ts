import { describe, expect, it } from "vitest";
import {
  CARD_MAX_MINOR,
  overCardCeiling,
  STUB_LISTINGS,
} from "./providers/stubListings.js";

describe("stub listings", () => {
  it("offers the three Shopee gin listings", () => {
    expect(STUB_LISTINGS).toHaveLength(3);
    expect(new Set(STUB_LISTINGS.map((l) => l.seller))).toEqual(new Set(["Shopee"]));
  });

  it("uses https urls on shopee.sg", () => {
    for (const listing of STUB_LISTINGS) {
      const url = new URL(listing.url);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("shopee.sg");
    }
  });

  it("states price consistently with amountMinor", () => {
    for (const listing of STUB_LISTINGS) {
      expect(listing.price).toBe(`S$${(listing.amountMinor / 100).toFixed(2)}`);
    }
  });

  /*
   * Documents a known limitation rather than asserting it away. Roku gin sells well above the
   * S$30 the StraitsX card can mint, so issueCard refuses these with a 400 before a browser opens.
   * If a listing is ever brought under the ceiling this test still passes — it only insists that
   * whatever is over it is over it knowingly.
   */
  it("knows which listings the card cannot pay for", () => {
    const over = overCardCeiling();
    expect(over.length).toBe(STUB_LISTINGS.length);
    for (const listing of over) {
      expect(listing.amountMinor).toBeGreaterThan(CARD_MAX_MINOR);
    }
  });
});
