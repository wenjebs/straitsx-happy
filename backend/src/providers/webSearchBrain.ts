import { createHash } from "node:crypto";
import type { VerifiedMerchant } from "../merchants.js";
import type {
  ScoutBrain,
  ScoutBudget,
  ScoutCandidate,
  ScoutDecision,
  ScoutItem,
  ScoutPick,
  ScoutTools,
} from "./scoutBrain.js";
import { relevance, ScriptedScoutBrain } from "./scoutBrain.js";
import type { ProductDetail } from "./storefront.js";

/**
 * Discovery by web search, verification by browser.
 *
 * The storefront-search route asks each shop's own `/search` for the wishlist wording, which is the
 * part that keeps failing: Shopify predictive search needs every term to match, and these shops
 * answer an AWS egress IP with an empty result set once they have been probed a few times. Both
 * failures look identical to "this shop stocks nothing", and the shortlist quietly falls back to
 * the crawled catalogue.
 *
 * So the finding moves off the shops. OpenAI's `web_search` tool runs the query against an index
 * that is already crawled, with `filters.allowed_domains` pinned to the verified hosts — the model
 * cannot return a product from anywhere else, which keeps the allowlist a property of the request
 * rather than of the prompt. What comes back is a set of product URLs.
 *
 * The browser then opens each one. That is not decoration: the price a scout shortlists has to be
 * the price the Closer's checkout will charge, and only `/products/<handle>.js` read on the page
 * gives that. It is also what the viewer watches, so the tiles keep showing real navigation.
 *
 * The two halves are deliberately separate calls. `find` needs no browser, so every item searches
 * at once while the session pool is still empty; `decide` then runs inside a session and spends it
 * entirely on opening and pricing. Doing the search inside the session instead would make the
 * sixteenth tile wait for three rounds of sessions before it had even issued its query.
 *
 * Web search cannot be combined with a JSON-schema response format, so nothing here asks the model
 * for structured output. The product URLs are read out of the response's own citations and search
 * sources, which needs no second model call and cannot hallucinate a handle.
 */
export interface WebSearchScoutOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Product pages opened in the browser per slot. Each one is a real page load. */
  maxProductOpens: number;
  fetcher?: typeof fetch;
}

const INSTRUCTIONS = [
  "You are a Happy shopping scout searching Singapore storefronts for one wishlist item.",
  "Use web search. Only the storefronts you are allowed to search exist; ignore every other shop.",
  "Find specific product pages that match the item, not category or collection pages.",
  "The purchase rail mints a single-use card, so prefer products whose price falls inside the stated budget range.",
  "List every candidate product page URL you found, one per line, and nothing else.",
].join(" ");

export class WebSearchScoutBrain implements ScoutBrain {
  readonly mode = "openai" as const;
  private readonly fallback = new ScriptedScoutBrain();

  constructor(private readonly options: WebSearchScoutOptions) {}

  /**
   * Pure HTTP to OpenAI: no browser, no AgentCore session, nothing that has to queue. Every item
   * runs this at the same moment, which is why the log fills up long before the first tile has a
   * session to show.
   */
  async find(input: {
    item: ScoutItem;
    merchants: VerifiedMerchant[];
    budget: ScoutBudget;
    userId: string;
    signal: AbortSignal;
    report(text: string): Promise<void>;
  }): Promise<ScoutCandidate[]> {
    const { item, merchants, budget, userId, signal, report } = input;
    await report("searching the web");

    const found = await this.search(item, merchants, budget, userId, signal).catch(
      (error: unknown) => {
        // A refused or unreachable search is not a reason to abandon the item; the storefront route
        // still works, slowly.
        console.warn(`web-search scout fell back for ${item.id}`, error);
        return null;
      },
    );
    if (signal.aborted || !found) {
      if (!found) await report("web search unavailable — falling back to storefront search");
      return [];
    }

    for (const query of found.queries.slice(0, 3)) await report(`query “${query}”`);
    if (found.candidates.length === 0) {
      await report("no product page on the verified shops matched");
      return [];
    }
    const shops = new Set(found.candidates.map((candidate) => candidate.merchant.host));
    await report(
      `${found.candidates.length} product pages on ${[...shops].join(", ")} — handing them to a browser to price`,
    );
    return found.candidates.map((candidate) => ({
      merchantId: candidate.merchant.id,
      handle: candidate.handle,
      url: candidate.url,
    }));
  }

  async decide(input: {
    item: ScoutItem;
    merchants: VerifiedMerchant[];
    budget: ScoutBudget;
    tools: ScoutTools;
    userId: string;
    signal: AbortSignal;
    prefetched?: ScoutCandidate[];
  }): Promise<ScoutDecision | null> {
    const { item, merchants, budget, tools, signal, prefetched } = input;

    // No candidates means the search phase came back empty for this item; the storefront route is
    // the remaining way to answer it, and the session is already open either way.
    if (!prefetched || prefetched.length === 0) return this.fallback.decide(input);

    const opened: ProductDetail[] = [];
    for (const candidate of prefetched.slice(0, this.options.maxProductOpens)) {
      if (signal.aborted) return null;
      // Opening drives the live browser, which is both the price check and the picture on screen.
      const detail = await tools
        .openProduct(candidate.merchantId, candidate.handle)
        .catch(() => null);
      if (detail) opened.push(detail);
    }

    const sells = new Map(merchants.map((merchant) => [merchant.id, merchant.sells]));
    const score = (product: ProductDetail) =>
      relevance(product.title, item, sells.get(product.merchantId));
    const affordable = opened
      .filter(
        (product) =>
          product.available &&
          product.priceMinor >= budget.minMinor &&
          product.priceMinor <= budget.maxMinor,
      )
      .sort((a, b) => score(b) - score(a) || a.priceMinor - b.priceMinor);

    const [best, ...rest] = affordable;
    // Web search proposed these products for this item, so an unrecognised title is not the
    // off-category accident `relevance` guards against on a blind storefront sweep. Rank on it,
    // but do not require it.
    if (!best) return this.fallback.decide(input);

    const pick: ScoutPick = {
      product: best,
      why: `Web search on ${best.host} matched "${item.name}" at a price the card can cover.`,
    };
    return {
      pick,
      alternates: rest.slice(0, 2).map((product) => ({
        product,
        why: "Also inside the band, kept as a retry candidate.",
      })),
    };
  }

  private async search(
    item: ScoutItem,
    merchants: VerifiedMerchant[],
    budget: ScoutBudget,
    userId: string,
    signal: AbortSignal,
  ): Promise<{ candidates: WebCandidate[]; queries: string[] }> {
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
          include: ["web_search_call.action.sources"],
          tools: [
            {
              type: "web_search",
              filters: { allowed_domains: merchants.map((merchant) => merchant.host) },
              user_location: { type: "approximate", country: "SG" },
            },
          ],
          input: [
            { role: "system", content: INSTRUCTIONS },
            {
              role: "user",
              content: [
                `Item: ${item.name}`,
                `Specification: ${item.spec}`,
                `Stated budget: ${item.budget}`,
                `Payable price range: S$${(budget.minMinor / 100).toFixed(2)} to S$${(budget.maxMinor / 100).toFixed(2)}`,
                `Allowed storefronts: ${merchants.map((merchant) => `${merchant.host} (${merchant.sells})`).join("; ")}`,
              ].join("\n"),
            },
          ],
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `OpenAI web search rejected the request (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const body = (await response.json()) as unknown;
    const { urls, queries } = harvest(body);
    return { candidates: toCandidates(urls, merchants), queries };
  }
}

interface WebCandidate {
  merchant: VerifiedMerchant;
  handle: string;
  url: string;
}

/**
 * Every URL the response touched, from three places: the citations attached to the answer, the
 * sources the search itself consulted, and any URL written into the answer text. A model told to
 * list URLs sometimes cites them and sometimes only types them, and a source list that never
 * became a citation still points at a real product page.
 */
function harvest(body: unknown): { urls: string[]; queries: string[] } {
  const urls: string[] = [];
  const queries: string[] = [];
  if (typeof body !== "object" || body === null) return { urls, queries };
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return { urls, queries };

  for (const entry of output) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as { type?: unknown; action?: unknown; content?: unknown };

    if (
      item.type === "web_search_call" &&
      typeof item.action === "object" &&
      item.action !== null
    ) {
      const action = item.action as { query?: unknown; sources?: unknown };
      if (typeof action.query === "string") queries.push(action.query);
      if (Array.isArray(action.sources)) {
        for (const source of action.sources) {
          const url = (source as { url?: unknown })?.url;
          if (typeof url === "string") urls.push(url);
        }
      }
      continue;
    }

    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (typeof part !== "object" || part === null) continue;
      const { text, annotations } = part as { text?: unknown; annotations?: unknown };
      if (Array.isArray(annotations)) {
        for (const annotation of annotations) {
          const url = (annotation as { url?: unknown })?.url;
          if (typeof url === "string") urls.push(url);
        }
      }
      if (typeof text === "string") {
        for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) urls.push(match[0]);
      }
    }
  }
  return { urls, queries };
}

/**
 * Product pages on merchants this slot owns, in the order the response produced them.
 *
 * Two filters do the safety work. A URL on a host outside the slot's list is dropped, so the
 * allowlist survives even if the search filter is ignored, and a slot never wanders into the other
 * slot's shops. A URL that is not `/products/<handle>` is dropped, because a collection page has no
 * price and nothing to open.
 */
function toCandidates(urls: string[], merchants: VerifiedMerchant[]): WebCandidate[] {
  const byHost = new Map(merchants.map((merchant) => [merchant.host, merchant]));
  const seen = new Set<string>();
  const candidates: WebCandidate[] = [];
  for (const raw of urls) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    const merchant = byHost.get(parsed.host.replace(/^www\./, "").toLowerCase());
    if (!merchant) continue;
    const handle = parsed.pathname.split("/products/")[1]?.split("/")[0];
    if (!handle) continue;
    const decoded = decodeURIComponent(handle);
    const key = `${merchant.id}::${decoded}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ merchant, handle: decoded, url: `${merchant.origin}/products/${decoded}` });
  }
  return candidates;
}
