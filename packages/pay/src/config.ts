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

const num = (v: string | undefined, fallback: number) =>
  v === undefined || v === "" ? fallback : Number(v);

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

  return Object.freeze({
    issuer,
    cardApiBase: required("CARD_API_BASE"),
    allowedNetwork: required("ALLOWED_NETWORK"),
    chainId: Number(required("CHAIN_ID")),
    rpcUrl: required("RPC_URL"),
    xsgdAddress: xsgd as `0x${string}`,
    spendPrivateKey: spendPrivateKey ?? null,
    cardholderName: env.CARDHOLDER_NAME ?? "Happy Agent",
    minCardCents: num(env.MIN_CARD_CENTS, 500),
    maxCardCents: num(env.MAX_CARD_CENTS, 3000),
    cardHeadroomCents: num(env.CARD_HEADROOM_CENTS, 0),
    priceToleranceBps: num(env.PRICE_TOLERANCE_BPS, 200),
    reservationTtlMs: num(env.RESERVATION_TTL_MS, 900_000),
    chainStaleMs: num(env.CHAIN_STALE_MS, 60_000),
    railBucketCapacity: num(env.RAIL_BUCKET_CAPACITY, 8),
    railBucketRefillMs: num(env.RAIL_BUCKET_REFILL_MS, 60_000),
    databaseUrl: required("DATABASE_URL"),
  });
}
