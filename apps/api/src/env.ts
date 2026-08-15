import { z } from "zod";

/**
 * One schema, parsed once at boot. A missing var must crash on startup, never
 * at the moment money moves.
 *
 * ISSUER, CARD_API_BASE and ALLOWED_NETWORK are the only things that differ
 * between mock / sandbox / production. Keep it that way — DESIGN.md §6.
 */
/**
 * A blank line in .env arrives as "" rather than undefined. Treat it as unset,
 * otherwise every commented-out optional var fails its own format check.
 */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const PrivateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex private key");

const Env = z.object({
  API_PORT: z.coerce.number().int().default(8787),

  CHAIN_ID: z.coerce.number().int().default(43113),
  ALLOWED_NETWORK: z.string().regex(/^eip155:\d+$/).default("eip155:43113"),
  RPC_URL: z.url(),
  XSGD_ADDRESS: z.string().regex(/^0x[0-9a-f]{40}$/, "must be lowercase hex — viem rejects a bad EIP-55 checksum"),
  BUNDLER_URL: z.url(),

  CARD_API_BASE: z.url(),
  CARD_MCP_URL: z.url(),

  ISSUER: z.enum(["mock", "straitsx"]).default("mock"),
  DEMO_STORE_URL: z.url().default("http://127.0.0.1:4030"),

  SPEND_KEY_MODE: z.enum(["kms", "local"]).default("local"),
  AWS_REGION: z.string().default("ap-southeast-1"),
  KMS_KEY_ID: optional(z.string()),
  AGENT_PRIVATE_KEY: optional(PrivateKey),
  OWNER_PRIVATE_KEY: optional(PrivateKey),

  MIN_CARD_SGD: z.coerce.number().default(5),
  MAX_CARD_SGD: z.coerce.number().default(30),
  SLIPPAGE_BPS: z.coerce.number().int().default(200),
  CHAIN_STALE_MS: z.coerce.number().int().default(60_000),

  DATABASE_URL: z.string().default("file:./happy.db"),
  SERVICE_TOKEN: z.string().min(1),
});

function load() {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment — see .env.example:");
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  const env = parsed.data;

  if (env.SPEND_KEY_MODE === "kms" && !env.KMS_KEY_ID) {
    console.error("SPEND_KEY_MODE=kms requires KMS_KEY_ID");
    process.exit(1);
  }
  if (env.SPEND_KEY_MODE === "local" && !env.AGENT_PRIVATE_KEY) {
    console.error("SPEND_KEY_MODE=local requires AGENT_PRIVATE_KEY");
    process.exit(1);
  }
  return env;
}

export const env = load();
export type Env = z.infer<typeof Env>;
