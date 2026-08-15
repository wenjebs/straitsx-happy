import { createHash } from "node:crypto";
import type { VerifiedMerchant } from "../merchants.js";
import type { Candidate, ProductDetail } from "./storefront.js";

/**
 * What decides where a scout browses.
 *
 * The model does not receive a page, a screenshot or any HTML — it receives the storefronts it is
 * allowed to visit and two tools, and the browser executes each tool call live. So the tile a user
 * is watching moves because the model chose to move it, which is the whole point of putting a real
 * browser behind the search phase.
 *
 * The tool surface is deliberately tiny. A model that can only search a named verified merchant and
 * open a product on that merchant cannot navigate to an arbitrary URL, which keeps the "scouts only
 * touch verified hosts" property a property of the code rather than of the prompt.
 */
export interface ScoutBudget {
  /** Card bounds, already adjusted for this merchant's shipping by the caller. */
  minMinor: number;
  maxMinor: number;
}

export interface ScoutItem {
  id: string;
  name: string;
  spec: string;
  budget: string;
}

export interface ScoutTools {
  searchStore(merchantId: string, query: string): Promise<Candidate[]>;
  openProduct(merchantId: string, handle: string): Promise<ProductDetail>;
}

export interface ScoutPick {
  product: ProductDetail;
  why: string;
}

export interface ScoutDecision {
  pick: ScoutPick;
  alternates: ScoutPick[];
}

export interface ScoutBrain {
  readonly mode: "openai" | "scripted";
  decide(input: {
    item: ScoutItem;
    merchants: VerifiedMerchant[];
    budget: ScoutBudget;
    tools: ScoutTools;
    userId: string;
    signal: AbortSignal;
  }): Promise<ScoutDecision | null>;
}

const SCOUT_INSTRUCTIONS = [
  "You are a Happy shopping scout. You are browsing real Singapore storefronts through a live browser to find one buyable product for one wishlist item.",
  "Use search_store to look at a storefront and open_product to read an exact price before you judge anything. A search result price can be a 'from' price and is not trustworthy; the open_product price is.",
  "Only the merchants listed in the request exist. Never invent a merchant id, a product handle, or a price.",
  "The purchase rail mints a single-use card, so the product price must fall inside the stated budget range. A product outside that range cannot be bought and must not be submitted.",
  "Prefer a product that genuinely matches the item's specification over one that merely fits the budget. If a storefront clearly does not sell this category, do not keep searching it.",
  "Call submit_shortlist exactly once when you have a pick, with up to two alternates that are also inside the budget range. Each 'why' is one plain sentence a shopper would accept.",
  "If nothing on any allowed storefront fits, call submit_shortlist with no pick and say why in no_match_reason.",
].join(" ");

export class ScriptedScoutBrain implements ScoutBrain {
  readonly mode = "scripted" as const;

  /**
   * The no-key path. It runs the same tools so the search phase, the livestream and the shortlist
   * all work without an LLM — useful offline, and the only thing that runs until OPENAI_API_KEY is
   * set.
   *
   * Search every storefront before opening anything. Opening as it goes would spend the whole
   * per-item budget of page loads on the first merchant in the list, which is how a scout looking
   * for a notebook ends up reading a book of poetry at the top of a bookshop's results.
   */
  async decide(input: {
    item: ScoutItem;
    merchants: VerifiedMerchant[];
    budget: ScoutBudget;
    tools: ScoutTools;
    signal: AbortSignal;
  }): Promise<ScoutDecision | null> {
    const { item, merchants, budget, tools, signal } = input;

    const found: { merchantId: string; candidate: Candidate }[] = [];
    for (const merchant of merchants) {
      if (signal.aborted) return null;
      const candidates = await tools.searchStore(merchant.id, item.name).catch(() => []);
      for (const candidate of candidates) {
        if (candidate.priceMinor === 0 || candidate.priceMinor <= budget.maxMinor) {
          found.push({ merchantId: merchant.id, candidate });
        }
      }
    }

    const sells = new Map(merchants.map((merchant) => [merchant.id, merchant.sells]));
    const ranked = found
      .map((entry) => ({
        ...entry,
        score: relevance(entry.candidate.title, item, sells.get(entry.merchantId)),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.candidate.priceMinor - b.candidate.priceMinor)
      .slice(0, 4);

    const opened: ProductDetail[] = [];
    for (const entry of ranked) {
      if (signal.aborted) return null;
      const detail = await tools
        .openProduct(entry.merchantId, entry.candidate.handle)
        .catch(() => null);
      if (detail) opened.push(detail);
    }

    const scoreOf = (product: ProductDetail) =>
      relevance(product.title, item, sells.get(product.merchantId));
    const affordable = opened
      .filter(
        (product) =>
          product.available &&
          product.priceMinor >= budget.minMinor &&
          product.priceMinor <= budget.maxMinor &&
          scoreOf(product) > 0,
      )
      .sort((a, b) => scoreOf(b) - scoreOf(a) || a.priceMinor - b.priceMinor);

    const [best, ...rest] = affordable;
    if (!best) return null;
    return {
      pick: {
        product: best,
        why: `Closest match to "${item.name}" within the card's spending band.`,
      },
      alternates: rest.slice(0, 2).map((product) => ({
        product,
        why: "Also inside the band, kept as a retry candidate.",
      })),
    };
  }
}

export interface OpenAIScoutOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxToolCalls: number;
  fetcher?: typeof fetch;
}

export class OpenAIScoutBrain implements ScoutBrain {
  readonly mode = "openai" as const;
  private readonly fallback = new ScriptedScoutBrain();

  constructor(private readonly options: OpenAIScoutOptions) {}

  async decide(input: {
    item: ScoutItem;
    merchants: VerifiedMerchant[];
    budget: ScoutBudget;
    tools: ScoutTools;
    userId: string;
    signal: AbortSignal;
  }): Promise<ScoutDecision | null> {
    const { item, merchants, budget, tools, userId, signal } = input;
    const opened = new Map<string, ProductDetail>();
    const history: unknown[] = [
      { role: "system", content: SCOUT_INSTRUCTIONS },
      {
        role: "user",
        content: JSON.stringify({
          item: { name: item.name, specification: item.spec, statedBudget: item.budget },
          budgetMinorSGD: { min: budget.minMinor, max: budget.maxMinor },
          merchants: merchants.map((merchant) => ({
            id: merchant.id,
            name: merchant.name,
            sells: merchant.sells,
            shippingMinorSGD: merchant.shippingMinor,
          })),
        }),
      },
    ];

    for (let turn = 0; turn < this.options.maxToolCalls; turn += 1) {
      if (signal.aborted) return null;
      const calls = await this.turn(history, userId, signal);
      if (calls.length === 0) break;

      let submitted: ScoutDecision | null | undefined;
      for (const call of calls) {
        history.push(call.raw);
        if (call.name === "submit_shortlist") {
          submitted = this.resolveSubmission(call.args, opened);
          history.push({
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify({ ok: submitted !== null }),
          });
          continue;
        }
        const output = await this.runTool(call, tools, opened, budget);
        history.push({
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify(output),
        });
      }
      if (submitted !== undefined) return submitted;
    }

    // Out of turns without a decision. The tools already walked real storefronts, so rank what the
    // model opened rather than throwing the run away.
    return this.fallback.decide(input);
  }

  private async turn(
    history: unknown[],
    userId: string,
    signal: AbortSignal,
  ): Promise<ToolCall[]> {
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
          safety_identifier: createHash("sha256").update(userId).digest("hex"),
          reasoning: { effort: "low" },
          tool_choice: "required",
          tools: SCOUT_TOOLS,
          input: history,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `OpenAI scout rejected the request (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const body = (await response.json()) as { output?: unknown };
    if (!Array.isArray(body.output)) return [];
    const calls: ToolCall[] = [];
    for (const entry of body.output) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as { type?: unknown; name?: unknown; call_id?: unknown; arguments?: unknown };
      if (item.type !== "function_call") continue;
      if (typeof item.name !== "string" || typeof item.call_id !== "string") continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}");
      } catch {
        args = {};
      }
      calls.push({ name: item.name, callId: item.call_id, args, raw: entry });
    }
    return calls;
  }

  private async runTool(
    call: ToolCall,
    tools: ScoutTools,
    opened: Map<string, ProductDetail>,
    budget: ScoutBudget,
  ): Promise<unknown> {
    try {
      if (call.name === "search_store") {
        const merchantId = String(call.args.merchant_id ?? "");
        const query = String(call.args.query ?? "");
        const results = await tools.searchStore(merchantId, query);
        return {
          results: results.map((candidate) => ({
            handle: candidate.handle,
            title: candidate.title,
            approxPriceMinorSGD: candidate.priceMinor || null,
          })),
        };
      }
      if (call.name === "open_product") {
        const merchantId = String(call.args.merchant_id ?? "");
        const handle = String(call.args.handle ?? "");
        const detail = await tools.openProduct(merchantId, handle);
        opened.set(key(merchantId, handle), detail);
        return {
          handle: detail.handle,
          title: detail.title,
          vendor: detail.vendor,
          priceMinorSGD: detail.priceMinor,
          available: detail.available,
          withinBudget:
            detail.priceMinor >= budget.minMinor && detail.priceMinor <= budget.maxMinor,
          summary: detail.summary,
        };
      }
      return { error: `Unknown tool ${call.name}` };
    } catch (error) {
      // A blocked storefront or a dead handle is information the model should route around, not a
      // reason to abandon the item.
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** A submission may only reference products the browser actually opened. */
  private resolveSubmission(
    args: Record<string, unknown>,
    opened: Map<string, ProductDetail>,
  ): ScoutDecision | null {
    const pickArg = args.pick;
    if (typeof pickArg !== "object" || pickArg === null) return null;
    const pick = this.resolvePick(pickArg as Record<string, unknown>, opened);
    if (!pick) return null;
    const alternates: ScoutPick[] = [];
    if (Array.isArray(args.alternates)) {
      for (const entry of args.alternates.slice(0, 2)) {
        if (typeof entry !== "object" || entry === null) continue;
        const resolved = this.resolvePick(entry as Record<string, unknown>, opened);
        if (resolved && resolved.product.url !== pick.product.url) alternates.push(resolved);
      }
    }
    return { pick, alternates };
  }

  private resolvePick(
    entry: Record<string, unknown>,
    opened: Map<string, ProductDetail>,
  ): ScoutPick | null {
    const merchantId = typeof entry.merchant_id === "string" ? entry.merchant_id : "";
    const handle = typeof entry.handle === "string" ? entry.handle : "";
    const product = opened.get(key(merchantId, handle));
    if (!product) return null;
    const why = typeof entry.why === "string" && entry.why.trim() ? entry.why.trim() : "Best match found.";
    return { product, why };
  }
}

interface ToolCall {
  name: string;
  callId: string;
  args: Record<string, unknown>;
  raw: unknown;
}

function key(merchantId: string, handle: string): string {
  return `${merchantId}::${handle}`;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
}

function overlap(text: string, item: { name: string; spec: string }): number {
  const wanted = words(`${item.name} ${item.spec}`);
  let hits = 0;
  for (const word of words(text)) if (wanted.has(word)) hits += 1;
  return hits;
}

/**
 * How well a product answers the request.
 *
 * Title overlap alone is not enough, and the failure is not subtle: a roaster names its beans
 * "Colombia Supremo", so a search for "filter coffee beans" scores it zero, while an electronics
 * shop's "Vortex Filter Subscription" scores one on the word "filter" and wins. The shop is the
 * missing signal — a coffee roaster sells coffee whether or not the word is on the bag.
 *
 * So the merchant's own description counts too, and the title is weighted above it. Zero means no
 * connection to the request through either route, which is the guard that stops a scout looking
 * for a notebook from shortlisting drumsticks because they were the only thing in band.
 */
export function relevance(
  title: string,
  item: { name: string; spec: string },
  merchantSells?: string,
): number {
  return overlap(title, item) * 2 + (merchantSells ? overlap(merchantSells, item) : 0);
}

const PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["merchant_id", "handle", "why"],
  properties: {
    merchant_id: { type: "string" },
    handle: { type: "string" },
    why: { type: "string" },
  },
} as const;

const SCOUT_TOOLS = [
  {
    type: "function",
    name: "search_store",
    description:
      "Search one allowed storefront through the live browser and return its product results.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["merchant_id", "query"],
      properties: {
        merchant_id: { type: "string", description: "An id from the merchants list." },
        query: { type: "string", description: "Search terms, as a shopper would type them." },
      },
    },
    strict: true,
  },
  {
    type: "function",
    name: "open_product",
    description:
      "Open one product page in the live browser and read its exact price, stock and description.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["merchant_id", "handle"],
      properties: {
        merchant_id: { type: "string" },
        handle: { type: "string", description: "A handle returned by search_store." },
      },
    },
    strict: true,
  },
  {
    type: "function",
    name: "submit_shortlist",
    description:
      "Finish this item. Every product referenced must already have been opened with open_product.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pick", "alternates", "no_match_reason"],
      properties: {
        pick: { anyOf: [PICK_SCHEMA, { type: "null" }] },
        alternates: { type: "array", maxItems: 2, items: PICK_SCHEMA },
        no_match_reason: { type: ["string", "null"] },
      },
    },
    strict: true,
  },
] as const;
