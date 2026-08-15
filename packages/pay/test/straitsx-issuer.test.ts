import { beforeEach, describe, expect, it, vi } from "vitest";
import { StraitsXIssuer } from "../src/issuer/straitsx.js";
import { TokenBucket } from "../src/x402/bucket.js";

// 1800 cents === S$18.00 === 18_000_000 atomic units (XSGD is 6dp).
// validateChallenge asserts exactly this relationship, so the fixture must hold it.
const entry = {
  scheme: "exact",
  network: "eip155:43113",
  amount: "18000000",
  asset: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
  payTo: "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8",
  maxTimeoutSeconds: 300,
  chainId: 43113,
  extra: { assetTransferMethod: "eip3009", name: "XSGD", version: "2" },
};

const cfg = {
  cardApiBase: "https://rail.test/cardapi",
  allowedNetwork: "eip155:43113",
  xsgdAddress: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
  cardholderName: "Happy Agent",
  minCardCents: 500,
  maxCardCents: 3000,
} as any;

const account = {
  address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
  signTypedData: vi.fn(async () => "0xsignature"),
} as any;

const challengeRes = () => new Response(JSON.stringify({ accepts: [entry] }), { status: 402 });

describe("StraitsXIssuer", () => {
  // signTypedData is a module-level vi.fn(); without this, call history leaks between cases
  // and the no-new-nonce assertion below silently inspects the wrong calls.
  beforeEach(() => vi.clearAllMocks());

  it("probes, signs, and pays with the envelope", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      calls.push(init);
      if (!init.headers["PAYMENT-SIGNATURE"]) return challengeRes();
      return new Response(
        JSON.stringify({
          card_opaque_id: "card_1",
          settlement_tx: "0xtx",
          card_html: "<div>4111 1111 1111 1111</div>",
        }),
        { status: 200 },
      );
    });

    const iss = new StraitsXIssuer(cfg, account, new TokenBucket(10, 60_000), fetchImpl as any);
    const req = { amountCents: 1800, cardholderName: "Happy Agent", idempotencyKey: "p1" };
    const prepared = await iss.prepare(req);
    const r = await iss.send(req, prepared);

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].body).amount_sgd).toBe(18);
    expect(JSON.parse(calls[0].body).wallet_address).toBe(account.address);
    expect(r.opaqueId).toBe("card_1");
    expect(r.settlementTx).toBe("0xtx");
    expect(prepared.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prepared.envelope).toBeTruthy();
  });

  it("sends fractional SGD for cent amounts", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: any) => {
      calls.push(init);
      if (!init.headers["PAYMENT-SIGNATURE"]) {
        return new Response(JSON.stringify({ accepts: [{ ...entry, amount: "18500000" }] }), {
          status: 402,
        });
      }
      return new Response(JSON.stringify({ card_opaque_id: "c", settlement_tx: null }), {
        status: 200,
      });
    });
    const iss = new StraitsXIssuer(cfg, account, new TokenBucket(10, 60_000), fetchImpl as any);
    const req = { amountCents: 1850, cardholderName: "Happy Agent", idempotencyKey: "p2" };
    await iss.send(req, await iss.prepare(req));
    expect(JSON.parse(calls[0]!.body).amount_sgd).toBe(18.5);
  });

  it("maps HTTP 429 to a rate-limit error without parsing the body as JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limit exceeded", { status: 429 }));
    const iss = new StraitsXIssuer(cfg, account, new TokenBucket(10, 60_000), fetchImpl as any);
    await expect(
      iss.prepare({ amountCents: 1800, cardholderName: "Happy Agent", idempotencyKey: "p3" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("refuses locally once the token bucket is empty, making no request", async () => {
    const fetchImpl = vi.fn(async () => challengeRes());
    const iss = new StraitsXIssuer(cfg, account, new TokenBucket(0, 60_000), fetchImpl as any);
    await expect(
      iss.prepare({ amountCents: 1800, cardholderName: "Happy Agent", idempotencyKey: "p4" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("replays a stored envelope instead of signing a new nonce", async () => {
    // This is the assertion that stands between us and a double payment. Do not weaken it.
    const fetchImpl = vi.fn(async (_u: string, init: any) =>
      init.headers["PAYMENT-SIGNATURE"]
        ? new Response(JSON.stringify({ card_opaque_id: "card_replay", settlement_tx: "0xtx" }), {
            status: 200,
          })
        : challengeRes(),
    );
    const iss = new StraitsXIssuer(cfg, account, new TokenBucket(10, 60_000), fetchImpl as any);
    const stored = {
      nonce: `0x${"ab".repeat(32)}` as const,
      envelope: "STORED_ENVELOPE",
      validBeforeMs: Date.now() + 300_000,
    };
    const r = await iss.send(
      { amountCents: 1800, cardholderName: "Happy Agent", idempotencyKey: "p5" },
      stored,
    );
    expect(account.signTypedData).not.toHaveBeenCalled(); // no new nonce was ever signed
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no probe, just the paid POST
    expect(r.opaqueId).toBe("card_replay");
  });
});
