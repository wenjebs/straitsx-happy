import { z } from "zod";

const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.url().optional());
const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const optionalAddress = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
);
const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(32).optional(),
);

const Env = z
  .object({
    PORT: z.coerce.number().int().positive().default(8787),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATA_STORE: z.enum(["memory", "dynamodb"]).default("memory"),
    DYNAMODB_TABLE: optionalString,
    DYNAMODB_ENDPOINT: optionalUrl,
    AWS_REGION: z.string().default("ap-southeast-1"),
    /**
     * Allowed browser origins, comma-separated.
     *
     * A list rather than one value because the single value is a trap: the laptop's LAN address
     * changes with DHCP, and a demo is watched on `localhost` while a phone on the same network
     * uses the IP. Either way the frontend has no mock to fall back to, so the wrong origin here
     * is a blank screen with a CORS error rather than a degraded UI.
     */
    FRONTEND_ORIGIN: z
      .string()
      .default("http://localhost:4040")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim().replace(/\/$/, ""))
          .filter(Boolean),
      ),
    PUBLIC_BASE_URL: z.url().default("http://localhost:8787"),
    AUTH_MODE: z.enum(["disabled", "local", "cognito"]).default("local"),
    AUTH_SESSION_SECRET: optionalSecret,
    COGNITO_USER_POOL_ID: optionalString,
    COGNITO_CLIENT_ID: optionalString,
    PLANNER_MODE: z.enum(["local", "openai", "remote", "disabled"]).default("local"),
    SCOUT_MODE: z.enum(["agentcore", "remote", "disabled"]).default("agentcore"),
    /** AgentCore Browser. Credentials come from the ambient AWS chain, never from this file. */
    AGENTCORE_BROWSER_ID: z.string().min(1).default("aws.browser.v1"),
    AGENTCORE_SESSION_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    /** One AgentCore session per concurrent scout, so this is the real cost dial. */
    AGENTCORE_MAX_SESSIONS: z.coerce.number().int().min(1).max(12).default(4),
    AGENTCORE_JPEG_QUALITY: z.coerce.number().int().min(20).max(95).default(60),
    /**
     * Signs the scout livestream's capability URLs. Defaults to a per-boot random value, which is
     * correct for one task; set it when several instances serve the same activity.
     */
    STREAM_TOKEN_SECRET: optionalString,
    SCOUT_SLOTS_PER_ITEM: z.coerce.number().int().min(1).max(4).default(2),
    SCOUT_MAX_TOOL_CALLS: z.coerce.number().int().min(2).max(24).default(10),
    /**
     * Where a scout finds candidates. `websearch` queries OpenAI's index with the verified hosts as
     * a domain filter and opens what it returns; `storefront` drives each shop's own search box,
     * which is slower and goes quiet when a shop throttles the AgentCore egress IP.
     */
    SCOUT_BRAIN: z.enum(["websearch", "storefront"]).default("websearch"),
    /** Product pages a web-search scout opens in the browser per item. Each one is a page load. */
    SCOUT_MAX_PRODUCT_OPENS: z.coerce.number().int().min(1).max(8).default(4),
    OPENAI_API_KEY: optionalString,
    OPENAI_MODEL: z.string().min(1).default("gpt-5.6-luna"),
    OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
    AGENT_API_BASE_URL: optionalUrl,
    AGENT_API_TOKEN: optionalString,
    AGENT_CALLBACK_TOKEN: optionalString,
    CARD_MODE: z.enum(["local", "straitsx", "remote", "disabled"]).default("local"),
    CARD_API_BASE_URL: optionalUrl,
    CARD_API_TOKEN: optionalString,
    PURCHASE_AGENT_MODE: z.enum(["local", "remote", "disabled"]).default("local"),
    PURCHASE_AGENT_API_BASE_URL: optionalUrl,
    PURCHASE_AGENT_API_TOKEN: optionalString,
    PURCHASE_CALLBACK_TOKEN: optionalString,
    FUNDING_MODE: z.enum(["chain", "disabled"]).default("disabled"),
    HAPPY_WALLET_ADDRESS: optionalAddress,
    CHAIN_ID: z.coerce.number().int().positive().default(43113),
    RPC_URL: optionalUrl,
    XSGD_ADDRESS: optionalAddress,
    XSGD_DECIMALS: z.coerce.number().int().min(2).max(18).default(6),
    FUNDING_NETWORK_NAME: z.string().min(1).default("Avalanche Fuji C-Chain"),
    FUNDING_EXPLORER_URL: z.url().default("https://subnets-test.avax.network/c-chain"),
    DEPOSIT_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(1),
    WALLET_AUTH_SECRET: optionalSecret,
    PAYMENT_MIN_MINOR: z.coerce.number().int().nonnegative().default(500),
    PAYMENT_MAX_MINOR: z.coerce.number().int().positive().default(3000),
    PAYMENT_ATTEMPTS_PER_LISTING: z.coerce.number().int().min(1).max(5).default(2),
    /*
     * Escape hatch for the hosted demo: run the mock card and mock closer on a deployed stack.
     * No card is ever minted and no value moves, so the flow is a walkthrough, not a purchase.
     */
    ALLOW_MOCK_MONEY: z
      .preprocess((value) => value === "true" || value === true, z.boolean())
      .default(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.ALLOW_MOCK_MONEY) {
      for (const field of ["PLANNER_MODE", "CARD_MODE", "PURCHASE_AGENT_MODE"] as const) {
        if (env[field] === "local") {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message:
              "cannot be local when NODE_ENV=production; configure remote, disabled, or set ALLOW_MOCK_MONEY=true to demo on mocks",
          });
        }
      }
    }
    if (env.DATA_STORE === "dynamodb" && !env.DYNAMODB_TABLE) {
      ctx.addIssue({
        code: "custom",
        path: ["DYNAMODB_TABLE"],
        message: "is required when DATA_STORE=dynamodb",
      });
    }
    if (env.AUTH_MODE === "local" && !env.AUTH_SESSION_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_SESSION_SECRET"],
        message: "is required when AUTH_MODE=local",
      });
    }
    if (env.AUTH_MODE === "cognito") {
      for (const field of ["COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID"] as const) {
        if (!env[field]) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "is required when AUTH_MODE=cognito",
          });
        }
      }
    }
    if ((env.PLANNER_MODE === "remote" || env.SCOUT_MODE === "remote") && !env.AGENT_API_BASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["AGENT_API_BASE_URL"],
        message: "is required when PLANNER_MODE=remote or SCOUT_MODE=remote",
      });
    }
    if (
      (env.PLANNER_MODE === "remote" ||
        env.SCOUT_MODE === "remote" ||
        (env.NODE_ENV === "production" && env.PLANNER_MODE === "openai")) &&
      !env.AGENT_CALLBACK_TOKEN
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["AGENT_CALLBACK_TOKEN"],
        message: "is required for remote callbacks and production OpenAI planning",
      });
    }
    if (env.PLANNER_MODE === "openai" && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "is required when PLANNER_MODE=openai",
      });
    }
    if (env.CARD_MODE === "remote" && !env.CARD_API_BASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["CARD_API_BASE_URL"],
        message: "is required when CARD_MODE=remote",
      });
    }
    if (env.PURCHASE_AGENT_MODE === "remote" && !env.PURCHASE_AGENT_API_BASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["PURCHASE_AGENT_API_BASE_URL"],
        message: "is required when PURCHASE_AGENT_MODE=remote",
      });
    }
    if (env.PURCHASE_AGENT_MODE === "remote" && !env.PURCHASE_CALLBACK_TOKEN) {
      ctx.addIssue({
        code: "custom",
        path: ["PURCHASE_CALLBACK_TOKEN"],
        message: "is required when PURCHASE_AGENT_MODE=remote",
      });
    }
    if (env.FUNDING_MODE === "chain") {
      for (const field of [
        "HAPPY_WALLET_ADDRESS",
        "RPC_URL",
        "XSGD_ADDRESS",
        "WALLET_AUTH_SECRET",
      ] as const) {
        if (!env[field]) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `is required when FUNDING_MODE=chain`,
          });
        }
      }
    }
    if (env.PAYMENT_MIN_MINOR > env.PAYMENT_MAX_MINOR) {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENT_MIN_MINOR"],
        message: "must be less than or equal to PAYMENT_MAX_MINOR",
      });
    }
  });

export type Config = z.infer<typeof Env>;

export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  const result = Env.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid backend environment:\n${details}`);
  }
  return result.data;
}
