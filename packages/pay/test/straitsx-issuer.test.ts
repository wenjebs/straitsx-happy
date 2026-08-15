import { readdirSync, readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StraitsXIssuer } from "../src/issuer/straitsx.js";
import { TokenBucket } from "../src/x402/bucket.js";

// send() dumps the raw rail response to ./card-responses/<nonce>.json before parsing it (see
// straitsx.ts) — every test that calls send() leaves one of these behind. Sweep them up so
// the working tree stays clean; they are gitignored regardless.
const CARD_RESPONSE_DIR = "./card-responses";

function sweepCardResponseFiles(): string[] {
  let files: string[];
  try {
    files = readdirSync(CARD_RESPONSE_DIR);
  } catch {
    return [];
  }
  for (const f of files) rmSync(`${CARD_RESPONSE_DIR}/${f}`, { force: true });
  return files;
}

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
  afterEach(() => sweepCardResponseFiles());

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

  it("reserves both tokens in prepare() so send() can transmit even off an empty bucket", async () => {
    const fetchImpl = vi.fn(async (_u: string, init: any) =>
      init.headers["PAYMENT-SIGNATURE"]
        ? new Response(JSON.stringify({ card_opaque_id: "card_x", settlement_tx: "0xtx" }), {
            status: 200,
          })
        : challengeRes(),
    );
    // Capacity 2: one token prepare() reserves explicitly for the paid leg, one it spends on
    // its own probe. The bucket is empty by the time send() runs.
    const iss = new StraitsXIssuer(cfg, account, new TokenBucket(2, 60_000), fetchImpl as any);
    const req = { amountCents: 1800, cardholderName: "Happy Agent", idempotencyKey: "p6" };
    const prepared = await iss.prepare(req);
    const r = await iss.send(req, prepared); // must not be refused for lack of budget
    expect(r.opaqueId).toBe("card_x");
  });

  it("fails prepare() before signing anything when the bucket cannot cover both legs", async () => {
    const fetchImpl = vi.fn(async () => challengeRes());
    const iss = new StraitsXIssuer(cfg, account, new TokenBucket(1, 60_000), fetchImpl as any);
    await expect(
      iss.prepare({ amountCents: 1800, cardholderName: "Happy Agent", idempotencyKey: "p7" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchImpl).not.toHaveBeenCalled(); // the probe's own token check failed first
  });

  it("reports rail status via the onRailStatus callback for OK, RATE_LIMITED, and ERROR", async () => {
    const statuses: string[] = [];
    const onRailStatus = (s: "OK" | "RATE_LIMITED" | "ERROR") => statuses.push(s);

    const okIssuer = new StraitsXIssuer(
      cfg,
      account,
      new TokenBucket(10, 60_000),
      vi.fn(async () => challengeRes()) as any,
      onRailStatus,
    );
    await okIssuer.prepare({
      amountCents: 1800,
      cardholderName: "Happy Agent",
      idempotencyKey: "r1",
    });
    expect(statuses).toEqual(["OK"]);

    statuses.length = 0;
    const rlIssuer = new StraitsXIssuer(
      cfg,
      account,
      new TokenBucket(10, 60_000),
      vi.fn(async () => new Response("slow down", { status: 429 })) as any,
      onRailStatus,
    );
    await expect(
      rlIssuer.prepare({ amountCents: 1800, cardholderName: "Happy Agent", idempotencyKey: "r2" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(statuses).toEqual(["RATE_LIMITED"]);

    statuses.length = 0;
    const errIssuer = new StraitsXIssuer(
      cfg,
      account,
      new TokenBucket(10, 60_000),
      vi.fn(async () => {
        throw new Error("socket hang up");
      }) as any,
      onRailStatus,
    );
    await expect(
      errIssuer.prepare({ amountCents: 1800, cardholderName: "Happy Agent", idempotencyKey: "r3" }),
    ).rejects.toThrow(/socket hang up/);
    expect(statuses).toEqual(["ERROR"]);
  });

  it("writes the raw response body to disk before parsing it, and never returns an undefined opaqueId", async () => {
    sweepCardResponseFiles(); // start from a clean slate for this test's own assertion
    const fetchImpl = vi.fn(async (_u: string, init: any) =>
      init.headers["PAYMENT-SIGNATURE"]
        ? new Response(JSON.stringify({ settlement_tx: "0xtx" }), { status: 200 }) // no card_opaque_id, no id
        : challengeRes(),
    );
    const iss = new StraitsXIssuer(cfg, account, new TokenBucket(10, 60_000), fetchImpl as any);
    const req = { amountCents: 1800, cardholderName: "Happy Agent", idempotencyKey: "p8" };
    const prepared = await iss.prepare(req);
    const r = await iss.send(req, prepared);
    expect(r.opaqueId).toBe(prepared.nonce); // falls back to the nonce, never undefined

    const created = readdirSync(CARD_RESPONSE_DIR);
    expect(created).toEqual([`${prepared.nonce}.json`]); // named after the payment, not the clock
    expect(JSON.parse(readFileSync(`${CARD_RESPONSE_DIR}/${created[0]!}`, "utf8"))).toMatchObject({
      settlement_tx: "0xtx",
    });
  });
});
