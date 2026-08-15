export type Cents = number;

export type Config = Readonly<{
  issuer: "mock" | "straitsx";
  cardApiBase: string;
  allowedNetwork: string;
  chainId: number;
  rpcUrl: string;
  xsgdAddress: `0x${string}`;
  spendPrivateKey: `0x${string}` | null; // never `?:` — exactOptionalPropertyTypes forbids assigning undefined
  cardholderName: string;
  minCardCents: Cents;
  maxCardCents: Cents;
  cardHeadroomCents: Cents;
  priceToleranceBps: number;
  reservationTtlMs: number;
  chainStaleMs: number;
  railBucketCapacity: number;
  railBucketRefillMs: number;
  databaseUrl: string;
}>;

// Parses a numeric env var, falling back when unset/blank. Never lets a malformed
// value (NaN from junk input) freeze into Config — that must crash at boot, not
// silently propagate as NaN through every downstream comparison.
const num = (name: string, v: string | undefined, fallback: number): number => {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid ${name}: ${JSON.stringify(v)} is not a number`);
  return n;
};

// Cents fields additionally must be whole numbers — the entire design depends on
// integer cents, so a fractional value (e.g. "500.5") must crash at boot too.
const centsNum = (name: string, v: string | undefined, fallback: number): number => {
  const n = num(name, v, fallback);
  if (!Number.isInteger(n))
    throw new Error(`invalid ${name}: ${JSON.stringify(v)} must be an integer number of cents`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`missing required env ${k}`);
    return v;
  };

  const issuer = (env.ISSUER ?? "mock") as "mock" | "straitsx";
  if (issuer !== "mock" && issuer !== "straitsx") throw new Error(`bad ISSUER: ${issuer}`);

  const xsgd = required("XSGD_ADDRESS");
  if (xsgd !== xsgd.toLowerCase())
    throw new Error("XSGD_ADDRESS must be lowercase — viem rejects bad EIP-55 casing");

  const spendPrivateKey = env.SPEND_PRIVATE_KEY as `0x${string}` | undefined;
  if (issuer === "straitsx" && !spendPrivateKey)
    throw new Error("SPEND_PRIVATE_KEY is required when ISSUER=straitsx");

  const chainIdRaw = required("CHAIN_ID");
  const chainId = Number(chainIdRaw);
  if (!Number.isFinite(chainId))
    throw new Error(`invalid CHAIN_ID: ${JSON.stringify(chainIdRaw)} is not a number`);
  if (!Number.isInteger(chainId))
    throw new Error(`invalid CHAIN_ID: ${JSON.stringify(chainIdRaw)} must be an integer`);

  return Object.freeze({
    issuer,
    cardApiBase: required("CARD_API_BASE"),
    allowedNetwork: required("ALLOWED_NETWORK"),
    chainId,
    rpcUrl: required("RPC_URL"),
    xsgdAddress: xsgd as `0x${string}`,
    spendPrivateKey: spendPrivateKey ?? null,
    cardholderName: env.CARDHOLDER_NAME ?? "Happy Agent",
    minCardCents: centsNum("MIN_CARD_CENTS", env.MIN_CARD_CENTS, 500),
    maxCardCents: centsNum("MAX_CARD_CENTS", env.MAX_CARD_CENTS, 3000),
    cardHeadroomCents: centsNum("CARD_HEADROOM_CENTS", env.CARD_HEADROOM_CENTS, 0),
    priceToleranceBps: num("PRICE_TOLERANCE_BPS", env.PRICE_TOLERANCE_BPS, 200),
    reservationTtlMs: num("RESERVATION_TTL_MS", env.RESERVATION_TTL_MS, 900_000),
    chainStaleMs: num("CHAIN_STALE_MS", env.CHAIN_STALE_MS, 60_000),
    railBucketCapacity: num("RAIL_BUCKET_CAPACITY", env.RAIL_BUCKET_CAPACITY, 8),
    railBucketRefillMs: num("RAIL_BUCKET_REFILL_MS", env.RAIL_BUCKET_REFILL_MS, 60_000),
    databaseUrl: required("DATABASE_URL"),
  });
}
