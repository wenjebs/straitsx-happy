import { describe, expect, it } from "vitest";
import { makeWallet } from "../src/wallet.js";

const baseCfg = {
  rpcUrl: "http://localhost:9999",
  xsgdAddress: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
} as any;

describe("makeWallet", () => {
  it("reports a mock wallet (no signing account) when ISSUER=mock, even with a private key set", () => {
    // A key left over in .env from rehearsal must not make an offline demo spend against the
    // real chain balance — mock-ness is defined by cfg.issuer, not by key presence.
    const cfg = {
      ...baseCfg,
      issuer: "mock",
      spendPrivateKey: `0x${"11".repeat(32)}`,
    } as any;
    const wallet = makeWallet(cfg);
    expect(wallet.account).toBeNull();
    expect(wallet.view()).toMatchObject({ balanceCents: Number.MAX_SAFE_INTEGER, ageMs: 0 });
  });

  it("builds a real signing account when ISSUER=straitsx and a key is set", () => {
    const cfg = {
      ...baseCfg,
      issuer: "straitsx",
      spendPrivateKey: `0x${"11".repeat(32)}`,
    } as any;
    const wallet = makeWallet(cfg);
    expect(wallet.account).not.toBeNull();
    expect(wallet.address).not.toBe("0x0000000000000000000000000000000000000000");
  });

  it("has no signing account when ISSUER=straitsx but no key is set", () => {
    const cfg = { ...baseCfg, issuer: "straitsx", spendPrivateKey: null } as any;
    const wallet = makeWallet(cfg);
    expect(wallet.account).toBeNull();
  });
});

describe("cold start", () => {
  it("ready() resolves even when the chain read fails, leaving the cache empty", async () => {
    const w = makeWallet({
      issuer: "straitsx",
      spendPrivateKey: `0x${"11".repeat(32)}`,
      rpcUrl: "http://127.0.0.1:1", // nothing listening: the read will fail
      xsgdAddress: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
    } as never);
    await w.ready(); // must not throw
    expect(w.view().ageMs).toBe(Number.MAX_SAFE_INTEGER); // stale → decisions fail closed
    w.stop();
  }, 30_000);

  it("ready() is a no-op in mock mode", async () => {
    const w = makeWallet({
      issuer: "mock",
      spendPrivateKey: `0x${"11".repeat(32)}`,
      rpcUrl: "http://127.0.0.1:1",
      xsgdAddress: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
    } as never);
    await w.ready();
    expect(w.view().balanceCents).toBe(Number.MAX_SAFE_INTEGER);
    w.stop();
  });
});
