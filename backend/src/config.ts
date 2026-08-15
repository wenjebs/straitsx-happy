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
    AGENT_API_BASE_URL: optionalUrl,
    AGENT_API_TOKEN: optionalString,
    AGENT_CALLBACK_TOKEN: optionalString,
    PAYMENT_API_BASE_URL: optionalUrl,
    PAYMENT_API_TOKEN: optionalString,
    PAYMENT_MIN_MINOR: z.coerce.number().int().nonnegative().default(500),
    PAYMENT_MAX_MINOR: z.coerce.number().int().positive().default(3000),
    PAYMENT_ATTEMPTS_PER_LISTING: z.coerce.number().int().min(1).max(5).default(2),
  })
  .superRefine((env, ctx) => {
    if (env.DATA_STORE === "dynamodb" && !env.DYNAMODB_TABLE) {
      ctx.addIssue({
        code: "custom",
        path: ["DYNAMODB_TABLE"],
        message: "is required when DATA_STORE=dynamodb",
      });
    }
    if (env.AGENT_API_BASE_URL && !env.AGENT_CALLBACK_TOKEN) {
      ctx.addIssue({
        code: "custom",
        path: ["AGENT_CALLBACK_TOKEN"],
        message: "is required when AGENT_API_BASE_URL is configured",
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
