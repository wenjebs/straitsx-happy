import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  ISSUER: "mock",
  CARD_API_BASE: "https://card.straitsx.ai/sandbox/cardapi",
  ALLOWED_NETWORK: "eip155:43113",
  CHAIN_ID: "43113",
  RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc",
  XSGD_ADDRESS: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
  DATABASE_URL: "file::memory:",
};

describe("loadConfig", () => {
  it("applies rail defaults", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.minCardCents).toBe(500);
    expect(c.maxCardCents).toBe(3000);
    expect(c.priceToleranceBps).toBe(200);
  });

  it("rejects an XSGD address that is not lowercase", () => {
    expect(() =>
      loadConfig({
        ...base,
        XSGD_ADDRESS: "0xD769410DC8772695A7F55A304D2125320A65C2A5",
      } as NodeJS.ProcessEnv),
    ).toThrow(/lowercase/);
  });

  it("requires a spend key when the issuer is straitsx", () => {
    expect(() => loadConfig({ ...base, ISSUER: "straitsx" } as NodeJS.ProcessEnv)).toThrow(
      /SPEND_PRIVATE_KEY/,
    );
  });

  it("rejects a malformed CHAIN_ID", () => {
    expect(() => loadConfig({ ...base, CHAIN_ID: "abc" } as NodeJS.ProcessEnv)).toThrow(/CHAIN_ID/);
  });

  it("rejects a fractional MIN_CARD_CENTS", () => {
    expect(() => loadConfig({ ...base, MIN_CARD_CENTS: "500.5" } as NodeJS.ProcessEnv)).toThrow(
      /MIN_CARD_CENTS/,
    );
  });
});
