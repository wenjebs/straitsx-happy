import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/x402/bucket.js";
import { buildEnvelope, parseChallenge, validateChallenge } from "../src/x402/client.js";

const cfg = {
  allowedNetwork: "eip155:43113",
  xsgdAddress: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
} as any;

const entry = {
  scheme: "exact",
  network: "eip155:43113",
  amount: "1800000",
  asset: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
  payTo: "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8",
  maxTimeoutSeconds: 300,
  chainId: 43113,
  extra: { assetTransferMethod: "eip3009", name: "XSGD", version: "2" },
};

describe("x402 challenge", () => {
  it("accepts a matching challenge", () => {
    expect(() => validateChallenge(entry, cfg, 180)).not.toThrow();
  });

  it("rejects a different network", () => {
    expect(() => validateChallenge({ ...entry, network: "eip155:43114" }, cfg, 180)).toThrow(
      /network/,
    );
  });

  it("rejects a different asset", () => {
    expect(() => validateChallenge({ ...entry, asset: "0xdeadbeef" }, cfg, 180)).toThrow(/asset/);
  });

  it("rejects an amount that does not match cents times 1e4", () => {
    // the message comes from @happy/shared's assertAtomicMatchesMinor — match loosely
    expect(() => validateChallenge({ ...entry, amount: "180000000" }, cfg, 180)).toThrow();
  });

  it("reads the header case-insensitively", () => {
    const b64 = Buffer.from(JSON.stringify({ accepts: [entry] })).toString("base64");
    const res = new Response("{}", { status: 402, headers: { "Payment-Required": b64 } });
    expect(parseChallenge(res, "{}").payTo).toBe(entry.payTo);
  });

  it("falls back to the body when the header is absent", () => {
    const res = new Response("", { status: 402 });
    expect(parseChallenge(res, JSON.stringify({ accepts: [entry] })).payTo).toBe(entry.payTo);
  });
});

describe("envelope", () => {
  it("uses accepted singular and x402Version 2, echoing the entry verbatim", () => {
    const env = buildEnvelope(entry, "0xsig", {
      from: "0xa",
      to: entry.payTo,
      value: "1800000",
      validAfter: "0",
      validBefore: "999",
      nonce: "0xnonce",
    });
    const decoded = JSON.parse(Buffer.from(env, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toEqual(entry);
    expect(decoded.accepts).toBeUndefined();
    expect(decoded.payload.signature).toBe("0xsig");
  });
});

describe("TokenBucket", () => {
  it("refuses once capacity is spent", () => {
    const b = new TokenBucket(2, 60_000, () => 0);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it("refills over time", () => {
    let now = 0;
    const b = new TokenBucket(1, 1000, () => now);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    now = 1001;
    expect(b.take()).toBe(true);
  });
});
