import { z } from "zod";

const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.url().optional());
const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const Env = z
  .object({
    PORT: z.coerce.number().int().positive().default(8787),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATA_STORE: z.enum(["memory", "dynamodb"]).default("memory"),
    DYNAMODB_TABLE: optionalString,
    DYNAMODB_ENDPOINT: optionalUrl,
    AWS_REGION: z.string().default("ap-southeast-1"),
    FRONTEND_ORIGIN: z.string().default("http://localhost:4040"),
    PUBLIC_BASE_URL: z.url().default("http://localhost:8787"),
    PLANNER_MODE: z.enum(["local", "openai", "remote", "disabled"]).default("local"),
    SCOUT_MODE: z.enum(["local", "remote", "disabled"]).default("local"),
    OPENAI_API_KEY: optionalString,
    OPENAI_MODEL: z.string().min(1).default("gpt-5.6-luna"),
    OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
    AGENT_API_BASE_URL: optionalUrl,
    AGENT_API_TOKEN: optionalString,
    AGENT_CALLBACK_TOKEN: optionalString,
    CARD_MODE: z.enum(["local", "remote", "disabled"]).default("local"),
    CARD_API_BASE_URL: optionalUrl,
    CARD_API_TOKEN: optionalString,
    PURCHASE_AGENT_MODE: z.enum(["local", "remote", "disabled"]).default("local"),
    PURCHASE_AGENT_API_BASE_URL: optionalUrl,
    PURCHASE_AGENT_API_TOKEN: optionalString,
    PURCHASE_CALLBACK_TOKEN: optionalString,
    PAYMENT_MIN_MINOR: z.coerce.number().int().nonnegative().default(500),
    PAYMENT_MAX_MINOR: z.coerce.number().int().positive().default(3000),
    PAYMENT_ATTEMPTS_PER_LISTING: z.coerce.number().int().min(1).max(5).default(2),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      for (const field of [
        "PLANNER_MODE",
        "SCOUT_MODE",
        "CARD_MODE",
        "PURCHASE_AGENT_MODE",
      ] as const) {
        if (env[field] === "local") {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "cannot be local when NODE_ENV=production; configure remote or disabled",
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
