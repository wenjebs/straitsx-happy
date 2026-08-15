import { describe, expect, it } from "vitest";
import { VERIFIED_MERCHANTS, type VerifiedMerchant } from "../merchants.js";
import type { ScoutCandidate } from "./scoutBrain.js";
import type { ProductDetail } from "./storefront.js";
import { WebSearchScoutBrain } from "./webSearchBrain.js";

const sweelee: VerifiedMerchant = (() => {
  const found = VERIFIED_MERCHANTS.find((merchant) => merchant.id === "sweelee");
  if (!found) throw new Error("merchant fixtures missing");
  return found;
})();

const item = {
  id: "item-1-guitar-picks",
  name: "Guitar picks",
  spec: "medium gauge, pack",
  budget: "up to S$15",
};
const budget = { minMinor: 500, maxMinor: 3000 };

function product(overrides: Partial<ProductDetail> & { handle: string }): ProductDetail {
  return {
    merchantId: "sweelee",
    host: "sweelee.com.sg",
    title: "Dunlop Guitar Picks 12-pack",
    url: `https://www.sweelee.com.sg/products/${overrides.handle}`,
    priceMinor: 1200,
    vendor: "Dunlop",
    available: true,
    summary: "",
    ...overrides,
  };
}

function brainWith(fetcher: typeof fetch): WebSearchScoutBrain {
  return new WebSearchScoutBrain({
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://api.openai.com/v1",
    maxProductOpens: 4,
    fetcher,
  });
}

function respond(body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status: 200 });
}

const RESULT = {
  output: [
    {
      type: "web_search_call",
      action: {
        type: "search",
        query: "guitar picks singapore",
        // A collection page and an off-allowlist shop both appear in real source lists.
        sources: [
          { url: "https://www.sweelee.com.sg/collections/picks" },
          { url: "https://shopee.sg/products/guitar-picks" },
        ],
      },
    },
    {
      content: [
        {
          type: "output_text",
          text: "https://www.sweelee.com.sg/products/dunlop-picks",
          annotations: [
            { type: "url_citation", url: "https://www.sweelee.com.sg/products/tortex-picks" },
          ],
        },
      ],
    },
  ],
};

async function find(brain: WebSearchScoutBrain, log: string[] = []): Promise<ScoutCandidate[]> {
  return brain.find({
    item,
    merchants: [sweelee],
    budget,
    userId: "user-1",
    signal: new AbortController().signal,
    report: async (text) => {
      log.push(text);
    },
  });
}

describe("WebSearchScoutBrain.find", () => {
  it("pins the search to the given hosts and keeps only their product pages", async () => {
    let request: Record<string, unknown> = {};
    const log: string[] = [];
    const brain = brainWith(async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(RESULT), { status: 200 });
    });

    const candidates = await find(brain, log);

    const tool = (request.tools as { type: string; filters: { allowed_domains: string[] } }[])[0];
    expect(tool?.type).toBe("web_search");
    expect(tool?.filters.allowed_domains).toEqual(["sweelee.com.sg"]);
    // No browser tools are handed to find at all, so this cannot have used a session.
    expect(candidates.map((candidate) => candidate.handle)).toEqual([
      "tortex-picks",
      "dunlop-picks",
    ]);
    expect(log.some((line) => line.includes("guitar picks singapore"))).toBe(true);
  });

  it("reports and returns nothing when the search call fails", async () => {
    const log: string[] = [];
    const brain = brainWith(async () => new Response("rate limited", { status: 429 }));

    expect(await find(brain, log)).toEqual([]);
    expect(log.some((line) => line.includes("unavailable"))).toBe(true);
  });
});

describe("WebSearchScoutBrain.decide", () => {
  it("opens what the search found and picks the best product inside the card band", async () => {
    const opened: string[] = [];
    const brain = brainWith(respond(RESULT));

    const decision = await brain.decide({
      item,
      merchants: [sweelee],
      budget,
      userId: "user-1",
      signal: new AbortController().signal,
      prefetched: [
        { merchantId: "sweelee", handle: "tortex-picks", url: "x" },
        { merchantId: "sweelee", handle: "dunlop-picks", url: "y" },
      ],
      tools: {
        searchStore: async () => {
          throw new Error("a prefetched scout must not touch the storefront search box");
        },
        openProduct: async (_merchantId, handle) => {
          opened.push(handle);
          return product({ handle, title: `${handle} 12-pack picks` });
        },
      },
    });

    expect(opened).toEqual(["tortex-picks", "dunlop-picks"]);
    expect(decision?.pick.product.handle).toBe("tortex-picks");
    expect(decision?.alternates).toHaveLength(1);
  });

  it("drops a product the card cannot pay for and lets the storefront route try", async () => {
    let storefrontQueries = 0;
    const brain = brainWith(respond(RESULT));

    const decision = await brain.decide({
      item,
      merchants: [sweelee],
      budget,
      userId: "user-1",
      signal: new AbortController().signal,
      prefetched: [{ merchantId: "sweelee", handle: "expensive-amp", url: "z" }],
      tools: {
        searchStore: async () => {
          storefrontQueries += 1;
          return [];
        },
        openProduct: async (_merchantId, handle) =>
          product({ handle, title: "Amplifier", priceMinor: 42_000 }),
      },
    });

    expect(decision).toBeNull();
    expect(storefrontQueries).toBeGreaterThan(0);
  });

  it("falls back to the storefront route when the search found nothing", async () => {
    const searched: string[] = [];
    const brain = brainWith(respond(RESULT));

    const decision = await brain.decide({
      item,
      merchants: [sweelee],
      budget,
      userId: "user-1",
      signal: new AbortController().signal,
      prefetched: [],
      tools: {
        searchStore: async (_merchantId, query) => {
          searched.push(query);
          return [
            {
              merchantId: "sweelee",
              host: "sweelee.com.sg",
              handle: "tortex-picks",
              title: "Tortex Guitar Picks",
              url: "https://www.sweelee.com.sg/products/tortex-picks",
              priceMinor: 1200,
            },
          ];
        },
        openProduct: async (_merchantId, handle) =>
          product({ handle, title: "Tortex Guitar Picks" }),
      },
    });

    expect(searched.length).toBeGreaterThan(0);
    expect(decision?.pick.product.handle).toBe("tortex-picks");
  });
});
