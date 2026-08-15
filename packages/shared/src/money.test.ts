import { describe, expect, it } from "vitest";
import {
  MoneyUnitError,
  assertAtomicMatchesMinor,
  assertIssuable,
  minorToAmountSgd,
  minorToAtomic,
  minorToSgd,
  sgdToMinor,
} from "./money.js";

describe("sgdToMinor", () => {
  it("converts whole and fractional amounts", () => {
    expect(sgdToMinor("18")).toBe(1800n);
    expect(sgdToMinor("18.5")).toBe(1850n);
    expect(sgdToMinor("18.05")).toBe(1805n);
    expect(sgdToMinor(18)).toBe(1800n);
  });

  it("rejects sub-cent precision instead of silently rounding", () => {
    expect(() => sgdToMinor("18.005")).toThrow(MoneyUnitError);
  });
});

describe("minorToSgd", () => {
  it("pads cents", () => {
    expect(minorToSgd(1800n)).toBe("18.00");
    expect(minorToSgd(1805n)).toBe("18.05");
    expect(minorToSgd(5n)).toBe("0.05");
  });
});

describe("the 1e4 slip", () => {
  it("minor -> atomic is exactly 10_000x", () => {
    expect(minorToAtomic(1800n)).toBe(18_000_000n);
  });

  it("accepts a matching challenge", () => {
    expect(() => assertAtomicMatchesMinor("18000000", 1800n)).not.toThrow();
  });

  it("refuses to sign a challenge that is 10_000x off", () => {
    expect(() => assertAtomicMatchesMinor("1800", 1800n)).toThrow(/Refusing to sign/);
    expect(() => assertAtomicMatchesMinor("180000000000", 1800n)).toThrow(/Refusing to sign/);
  });
});

describe("rail limits", () => {
  it("accepts the issuable band", () => {
    expect(() => assertIssuable(500n)).not.toThrow();
    expect(() => assertIssuable(3000n)).not.toThrow();
  });

  it("rejects outside it — StraitsX returns 400 at amount_sgd:31", () => {
    expect(() => assertIssuable(499n)).toThrow(MoneyUnitError);
    expect(() => assertIssuable(3100n)).toThrow(MoneyUnitError);
  });

  it("wire format is a plain decimal", () => {
    expect(minorToAmountSgd(1800n)).toBe("18.00");
  });
});
