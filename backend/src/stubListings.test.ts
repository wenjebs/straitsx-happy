import { describe, expect, it } from "vitest";
import {
  CARD_MAX_MINOR,
  CARD_MIN_MINOR,
  overCardCeiling,
  STUB_LISTINGS,
} from "./providers/stubListings.js";

describe("stub listings", () => {
  it("offers three Shopee listings", () => {
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
   * The check that would have caught the gin listings before they reached the UI. Anything above
   * S$30 is refused by the payment rail — "Payment rail denied ...: S$78.00 is outside the issuable
   * range" — before a browser is ever opened, so a listing over the ceiling is a listing that can
   * never be bought.
   */
  it("prices every listing inside the card's mint bounds", () => {
    expect(overCardCeiling()).toEqual([]);
    for (const listing of STUB_LISTINGS) {
      expect(listing.amountMinor).toBeGreaterThanOrEqual(CARD_MIN_MINOR);
      expect(listing.amountMinor).toBeLessThanOrEqual(CARD_MAX_MINOR);
    }
  });
});
