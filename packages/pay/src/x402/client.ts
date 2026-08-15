import { randomBytes } from "node:crypto";
import { assertAtomicMatchesMinor } from "@happy/shared";
import type { Cents, Config } from "../config.js";

export type ChallengeEntry = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  chainId: number;
  extra: { assetTransferMethod: string; name: string; version: string };
};

export type Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
};

export class X402Error extends Error {
  constructor(
    public readonly code: "RATE_LIMITED" | "BAD_CHALLENGE" | "REJECTED" | "UNAVAILABLE",
    msg: string,
  ) {
    super(msg);
    this.name = "X402Error";
  }
}

const b64e = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const b64d = (s: string) => JSON.parse(Buffer.from(s.trim(), "base64").toString("utf8"));

/** Apache emits `Payment-Required:` in title case — look it up case-insensitively. */
function header(h: Headers, name: string): string | undefined {
  for (const [k, v] of h) if (k.toLowerCase() === name) return v;
  return undefined;
}

export function parseChallenge(res: Response, bodyText: string): ChallengeEntry {
  const raw = header(res.headers, "payment-required");
  const doc = raw ? b64d(raw) : JSON.parse(bodyText);
  const entry = doc?.accepts?.[0];
  if (!entry)
    throw new X402Error(
      "BAD_CHALLENGE",
      `no accepts entry in challenge: ${bodyText.slice(0, 200)}`,
    );
  return entry as ChallengeEntry;
}

export function validateChallenge(
  entry: ChallengeEntry,
  cfg: Pick<Config, "allowedNetwork" | "xsgdAddress">,
  cents: Cents,
) {
  if (entry.scheme !== "exact")
    throw new X402Error("BAD_CHALLENGE", `unexpected scheme ${entry.scheme}`);
  if (entry.network !== cfg.allowedNetwork)
    throw new X402Error("BAD_CHALLENGE", `refusing network ${entry.network}`);
  if (entry.asset.toLowerCase() !== cfg.xsgdAddress)
    throw new X402Error("BAD_CHALLENGE", `unexpected asset ${entry.asset}`);
  if (entry.extra?.assetTransferMethod !== "eip3009")
    throw new X402Error("BAD_CHALLENGE", "unexpected transfer method");
  // Delegate the 1e4 check to @happy/shared so there is exactly one implementation of it.
  // The helper is bigint-only: passing a number throws `Cannot mix BigInt and other types`.
  try {
    assertAtomicMatchesMinor(entry.amount, BigInt(cents));
  } catch (e) {
    throw new X402Error("BAD_CHALLENGE", (e as Error).message);
  }
}

export function newNonce(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}

export function buildAuthorization(
  entry: ChallengeEntry,
  from: string,
  nonce: `0x${string}`,
  nowSec = Math.floor(Date.now() / 1000),
): Authorization {
  return {
    from: from.toLowerCase(),
    to: entry.payTo,
    value: entry.amount,
    validAfter: "0",
    validBefore: String(nowSec + entry.maxTimeoutSeconds),
    nonce,
  };
}

/** VERIFIED LIVE: `accepted` is singular and x402Version is 2. The array form is rejected. */
export function buildEnvelope(
  entry: ChallengeEntry,
  signature: string,
  authorization: Authorization,
): string {
  return b64e({ x402Version: 2, accepted: entry, payload: { signature, authorization } });
}

export const eip712 = (entry: ChallengeEntry, authorization: Authorization) => ({
  domain: {
    name: entry.extra.name,
    version: entry.extra.version,
    chainId: Number(entry.network.split(":")[1]),
    verifyingContract: entry.asset.toLowerCase() as `0x${string}`,
  },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization" as const,
  message: {
    from: authorization.from as `0x${string}`,
    to: authorization.to as `0x${string}`,
    value: BigInt(authorization.value),
    validAfter: 0n,
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  },
});
