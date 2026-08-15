import { describe, expect, it } from "vitest";
import { STUB_LISTINGS } from "./providers/stubListings.js";

describe("stub listings", () => {
  it("offers five listings across Shopee and Lazada", () => {
    expect(STUB_LISTINGS).toHaveLength(5);
    const sellers = new Set(STUB_LISTINGS.map((l) => l.seller));
    expect(sellers).toEqual(new Set(["Shopee", "Lazada"]));
  });

  it("uses https urls on the sellers' own domains", () => {
    for (const listing of STUB_LISTINGS) {
      const url = new URL(listing.url);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toMatch(/shopee\.sg$|lazada\.sg$/);
    }
  });

  // Outside S$5-30 the card API refuses issuance with a 400 before a browser ever opens.
  it("prices every listing inside the card's mint bounds", () => {
    for (const listing of STUB_LISTINGS) {
      expect(listing.amountMinor).toBeGreaterThanOrEqual(500);
      expect(listing.amountMinor).toBeLessThanOrEqual(3000);
    }
  });

  it("states price consistently with amountMinor", () => {
    for (const listing of STUB_LISTINGS) {
      expect(listing.price).toBe(`S$${(listing.amountMinor / 100).toFixed(2)}`);
    }
  });
});
