import { describe, expect, it } from "vitest";
import { defaultStreamSecret, mintStreamToken, verifyStreamToken } from "./streamTokens.js";

const SECRET = "stream-secret-for-tests";

describe("scout livestream tokens", () => {
  it("accepts a token minted for that agent", () => {
    const token = mintStreamToken(SECRET, "scout-notebook-0", 600);
    expect(verifyStreamToken(SECRET, "scout-notebook-0", token)).toBe(true);
  });

  it("refuses a stream with no token, which is the enumeration hole it exists to close", () => {
    expect(verifyStreamToken(SECRET, "scout-notebook-0", undefined)).toBe(false);
    expect(verifyStreamToken(SECRET, "scout-notebook-0", "")).toBe(false);
  });

  it("refuses another agent's token, so one valid tile does not unlock the rest", () => {
    const token = mintStreamToken(SECRET, "scout-notebook-0", 600);
    expect(verifyStreamToken(SECRET, "scout-filter-coffee-0", token)).toBe(false);
  });

  it("refuses an expired token", () => {
    const token = mintStreamToken(SECRET, "scout-notebook-0", -1);
    expect(verifyStreamToken(SECRET, "scout-notebook-0", token)).toBe(false);
  });

  it("refuses a token signed with a different secret", () => {
    const token = mintStreamToken(defaultStreamSecret(), "scout-notebook-0", 600);
    expect(verifyStreamToken(SECRET, "scout-notebook-0", token)).toBe(false);
  });

  it("refuses a tampered expiry, which would otherwise extend the token forever", () => {
    const token = mintStreamToken(SECRET, "scout-notebook-0", 600);
    const signature = token.slice(token.indexOf(".") + 1);
    const forged = `${Math.floor(Date.now() / 1000) + 999_999}.${signature}`;
    expect(verifyStreamToken(SECRET, "scout-notebook-0", forged)).toBe(false);
  });

  it("refuses malformed tokens rather than throwing", () => {
    for (const bad of ["garbage", ".", "abc.def", "123", ".deadbeef"]) {
      expect(verifyStreamToken(SECRET, "scout-notebook-0", bad)).toBe(false);
    }
  });
});
