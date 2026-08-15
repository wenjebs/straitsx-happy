import { describe, expect, it } from "vitest";
import { isVerifiedHost, merchantById, merchantsForSlot, VERIFIED_MERCHANTS } from "./merchants.js";

describe("verified merchant allowlist", () => {
  it("contains unique Shopify storefronts with safe HTTPS origins", () => {
    expect(VERIFIED_MERCHANTS.length).toBeGreaterThanOrEqual(40);
    // The whole list is sent as one Responses API web-search domain filter.
    expect(VERIFIED_MERCHANTS.length).toBeLessThanOrEqual(100);
    expect(new Set(VERIFIED_MERCHANTS.map((merchant) => merchant.id)).size).toBe(
      VERIFIED_MERCHANTS.length,
    );
    expect(new Set(VERIFIED_MERCHANTS.map((merchant) => merchant.host)).size).toBe(
      VERIFIED_MERCHANTS.length,
    );

    for (const merchant of VERIFIED_MERCHANTS) {
      const origin = new URL(merchant.origin);
      expect(origin.protocol).toBe("https:");
      expect(origin.hostname.replace(/^www\./, "")).toBe(merchant.host);
      expect(merchant.host).not.toMatch(/shopee|lazada|amazon/i);
      expect(merchant.sells.length).toBeGreaterThan(10);
      expect(merchant.shippingMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it("recognises allowlisted hosts with or without www", () => {
    expect(isVerifiedHost("www.spigen.com.sg")).toBe(true);
    expect(isVerifiedHost("spigen.com.sg")).toBe(true);
    expect(isVerifiedHost("shopee.sg")).toBe(false);
    expect(merchantById("cityluxe")?.host).toBe("cityluxe.sg");
  });

  it("deals every merchant to exactly one scout slot", () => {
    const slots = [merchantsForSlot(0, 2), merchantsForSlot(1, 2)];
    const assigned = slots.flat();
    expect(assigned).toHaveLength(VERIFIED_MERCHANTS.length);
    expect(new Set(assigned.map((merchant) => merchant.id)).size).toBe(VERIFIED_MERCHANTS.length);
    expect(slots.every((slot) => slot.length > 0)).toBe(true);
  });
});
