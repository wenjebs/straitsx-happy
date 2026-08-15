import { createHash } from "node:crypto";
import { z } from "zod";
import type { Activity } from "../domain.js";
import { asMessage, HttpError } from "../errors.js";
import type { PlannerProvider } from "./agent.js";

const PLANNER_INSTRUCTIONS = [
  "You are Happy's shopping planner. Convert the user's request into a practical editable wishlist of separate purchasable items.",
  "For any build, DIY, setup, kit, or outcome request, return a complete starter bill of materials: decompose the outcome into its individual components, materials, consumables, and essential tools, like the individual parts in a PC build.",
  "Never return one generic project, bundle, or pending-details placeholder and never postpone the wishlist until the user supplies more detail.",
  "When details are missing, choose common practical defaults, state the assumptions in the reply and item specifications, and still return an actionable list.",
  "For example, 'build a table' needs separate wishlist items for the tabletop, legs or base, joinery or fasteners, adhesive, abrasives, finish, and essential tools that should not be assumed to be owned.",
  "Ask clarification questions only when an answer materially changes a specific item's search; emit at most one clarification per wishlist item and never repeat a question.",
  "Preserve explicit quantities, constraints, brands, budgets, and location. Never claim that anything has been purchased or approved. Currency is SGD unless the user clearly requests another currency.",
].join(" ");

const PlannedWishlist = z.object({
  title: z.string().min(1).max(240),
  reply: z.string().min(1).max(4000),
  wishlistEstimate: z.string().min(1).max(100),
  wishlist: z
    .array(
      z.object({
        name: z.string().min(1).max(240),
        // Accept a verbose model label here, then normalize it to the callback's
        // 16-character UI contract. The JSON Schema also asks the model to stay
        // within that contract, but this keeps one imperfect response recoverable.
        short: z.string().min(1).max(240),
        spec: z.string().min(1).max(1000),
        budget: z.string().min(1).max(100),
        category: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(10),
  clarifications: z
    .array(
      z.object({
        itemIndex: z.number().int().min(0).max(9),
        prompt: z.string().min(1).max(1000),
        options: z
          .array(
            z.object({
              name: z.string().min(1).max(240),
              range: z.string().max(100),
              why: z.string().max(1000),
              imgLabel: z.string().max(100),
            }),
          )
          .min(2)
          .max(4),
      }),
    )
    .max(10),
});

export interface OpenAIPlannerOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  callbackBaseUrl: string;
  callbackToken?: string;
  fetcher?: typeof fetch;
}

/** Happy-owned planner. OpenAI returns schema-constrained data; Happy assigns durable ids. */
export class OpenAIPlannerProvider implements PlannerProvider {
  readonly mode = "openai" as const;

  constructor(private readonly options: OpenAIPlannerOptions) {}

  async startPlanning(activity: Activity): Promise<void> {
    void this.plan(activity).catch(async (error) => {
      try {
        await this.postCallback(activity.id, {
          type: "run.failed",
          message: `Happy could not prepare the wishlist: ${asMessage(error)}`,
        });
      } catch (callbackError) {
        console.error("OpenAI planner and failure callback both failed", callbackError);
      }
    });
  }

  private async plan(activity: Activity): Promise<void> {
    const goal =
      activity.messages.find((message) => message.role === "user")?.text ?? activity.title;
    const response = await (this.options.fetcher ?? fetch)(
      `${this.options.baseUrl.replace(/\/$/, "")}/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          store: false,
          safety_identifier: createHash("sha256").update(activity.userId).digest("hex"),
          reasoning: { effort: "low" },
          input: [
            {
              role: "system",
              content: PLANNER_INSTRUCTIONS,
            },
            { role: "user", content: goal },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "happy_wishlist",
              strict: true,
              schema: wishlistJsonSchema,
            },
          },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new HttpError(
        502,
        `OpenAI planner rejected the request (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      );
    }
    const data: unknown = await response.json();
    const plan = PlannedWishlist.parse(JSON.parse(extractOutputText(data)));
    const ids = plan.wishlist.map((item, index) => itemId(item.name, index));
    if (plan.clarifications.some((row) => row.itemIndex >= ids.length)) {
      throw new Error("OpenAI returned a clarification outside the wishlist.");
    }
    await this.postCallback(activity.id, {
      type: "wishlist.ready",
      title: plan.title,
      reply: plan.reply,
      wishlistEstimate: plan.wishlistEstimate,
      wishlist: plan.wishlist.map((item, index) => ({
        id: ids[index],
        ...item,
        short: normalizeShort(item.short),
        hueIndex: index % 6,
      })),
      clarifications: plan.clarifications.map((row) => ({
        itemId: ids[row.itemIndex],
        prompt: row.prompt,
        options: row.options,
      })),
    });
  }

  private async postCallback(activityId: string, body: unknown): Promise<void> {
    const response = await (this.options.fetcher ?? fetch)(
      `${this.options.callbackBaseUrl.replace(/\/$/, "")}/v1/integrations/agents/${encodeURIComponent(activityId)}/events`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.callbackToken
            ? { authorization: `Bearer ${this.options.callbackToken}` }
            : {}),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Happy rejected its OpenAI plan (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
  }
}

function extractOutputText(value: unknown): string {
  if (typeof value !== "object" || value === null)
    throw new Error("OpenAI returned no response object.");
  const response = value as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }
  if (!Array.isArray(response.output)) throw new Error("OpenAI returned no structured output.");
  for (const item of response.output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const text = (part as { type?: unknown; text?: unknown }).text;
      if ((part as { type?: unknown }).type === "output_text" && typeof text === "string")
        return text;
    }
  }
  throw new Error("OpenAI returned no output text.");
}

function itemId(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
  return `item-${index + 1}-${slug || "product"}`;
}

function normalizeShort(value: string): string {
  return Array.from(value.trim().replace(/\s+/g, " ").toUpperCase()).slice(0, 16).join("");
}

const wishlistJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "reply", "wishlistEstimate", "wishlist", "clarifications"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 240 },
    reply: { type: "string", minLength: 1, maxLength: 4000 },
    wishlistEstimate: { type: "string", minLength: 1, maxLength: 100 },
    wishlist: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "short", "spec", "budget", "category"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 240 },
          short: { type: "string", minLength: 1, maxLength: 16 },
          spec: { type: "string", minLength: 1, maxLength: 1000 },
          budget: { type: "string", minLength: 1, maxLength: 100 },
          category: { type: "string", minLength: 1, maxLength: 100 },
        },
      },
    },
    clarifications: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemIndex", "prompt", "options"],
        properties: {
          itemIndex: { type: "integer", minimum: 0, maximum: 9 },
          prompt: { type: "string", minLength: 1, maxLength: 1000 },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "range", "why", "imgLabel"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 240 },
                range: { type: "string", maxLength: 100 },
                why: { type: "string", maxLength: 1000 },
                imgLabel: { type: "string", maxLength: 100 },
              },
            },
          },
        },
      },
    },
  },
} as const;
