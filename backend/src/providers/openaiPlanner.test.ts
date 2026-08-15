import { describe, expect, it } from "vitest";
import type { Activity } from "../domain.js";
import { DEFAULT_USER_ID } from "../domain.js";
import { OpenAIPlannerProvider } from "./openaiPlanner.js";

describe("OpenAIPlannerProvider", () => {
  it("requests strict structured output and posts a normalized wishlist callback", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/responses")) {
        return new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      title: "Home office refresh",
                      reply: "I prepared two items and one useful clarification.",
                      wishlistEstimate: "est. S$70–S$100",
                      wishlist: [
                        {
                          name: "Desk lamp",
                          short: "USB-C cable accessory",
                          spec: "dimmable LED",
                          budget: "S$30–S$45",
                          category: "General",
                        },
                        {
                          name: "Laptop stand",
                          short: "stand",
                          spec: "adjustable aluminium",
                          budget: "S$40–S$55",
                          category: "Electronics",
                        },
                      ],
                      clarifications: [
                        {
                          itemIndex: 0,
                          prompt: "Which light temperature do you prefer?",
                          options: [
                            {
                              name: "Warm",
                              range: "2700K–3000K",
                              why: "Softer evening light",
                              imgLabel: "warm lamp",
                            },
                            {
                              name: "Neutral",
                              range: "4000K",
                              why: "Clear task lighting",
                              imgLabel: "neutral lamp",
                            },
                          ],
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
    };
    const planner = new OpenAIPlannerProvider({
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://api.openai.test/v1",
      callbackBaseUrl: "http://localhost:8787",
      callbackToken: "callback-secret",
      fetcher,
    });

    await planner.startPlanning(activity());
    for (let attempt = 0; attempt < 50 && calls.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(calls).toHaveLength(2);
    const request = JSON.parse(String(calls[0]?.init?.body)) as {
      store: boolean;
      input: { role: string; content: string }[];
      text: { format: { type: string; strict: boolean; schema: unknown } };
    };
    expect(request.store).toBe(false);
    expect(request.input[0]?.content).toContain("complete starter bill of materials");
    expect(request.input[0]?.content).toContain("Never return one generic project");
    expect(request.input[0]?.content).toContain("at most one clarification per wishlist item");
    expect(request.input[0]?.content).toContain("must return exactly one wishlist item");
    expect(request.input[0]?.content).toContain(
      "Do not introduce any brand or model that the user did not explicitly name",
    );
    expect(request.text.format).toMatchObject({
      type: "json_schema",
      strict: true,
      schema: {
        properties: {
          wishlist: { items: { properties: { short: { minLength: 1, maxLength: 16 } } } },
        },
      },
    });
    const callback = JSON.parse(String(calls[1]?.init?.body)) as {
      type: string;
      wishlist: { id: string; short: string }[];
      clarifications: { itemId: string }[];
    };
    expect(callback.type).toBe("wishlist.ready");
    expect(callback.wishlist).toHaveLength(2);
    expect(callback.wishlist[0]).toMatchObject({
      id: "item-1-desk-lamp",
      short: "USB-C CABLE ACCE",
    });
    expect(callback.wishlist[0]?.short).toHaveLength(16);
    expect(callback.clarifications[0]?.itemId).toBe("item-1-desk-lamp");
  });

  it("collapses branded alternatives for a direct singular request", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const brands = ["Logitech", "Razer", "Dell", "Microsoft", "Lenovo"];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/responses")) {
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              title: "Five computer mouse recommendations",
              reply: `Consider ${brands.join(", ")}.`,
              wishlistEstimate: "S$20–S$180",
              wishlist: brands.map((brand) => ({
                name: `${brand} wireless mouse`,
                short: `${brand} mouse`,
                spec: `${brand} model with Bluetooth`,
                budget: "S$20–S$180",
                category: "Computer accessories",
              })),
              clarifications: [
                {
                  itemIndex: 2,
                  prompt: "Do you have a preferred brand?",
                  options: [
                    {
                      name: "No preference",
                      range: "",
                      why: "Let Happy choose the best fit",
                      imgLabel: "computer mouse",
                    },
                    {
                      name: "Logitech",
                      range: "S$20–S$180",
                      why: "A commonly available option",
                      imgLabel: "Logitech mouse",
                    },
                  ],
                },
              ],
            }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
    };
    const planner = new OpenAIPlannerProvider({
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://api.openai.test/v1",
      callbackBaseUrl: "http://localhost:8787",
      fetcher,
    });

    await planner.startPlanning(activity("I want a computer mouse"));
    for (let attempt = 0; attempt < 50 && calls.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(calls).toHaveLength(2);
    const callback = JSON.parse(String(calls[1]?.init?.body)) as {
      title: string;
      reply: string;
      wishlist: { id: string; name: string; short: string; spec: string }[];
      clarifications: { itemId: string; prompt: string }[];
    };
    expect(callback.title).toBe("Computer mouse");
    expect(callback.reply).not.toMatch(/Logitech|Razer|Dell|Microsoft|Lenovo/i);
    expect(callback.wishlist).toEqual([
      expect.objectContaining({
        id: "item-1-computer-mouse",
        name: "Computer mouse",
        short: "COMPUTER MOUSE",
      }),
    ]);
    expect(callback.wishlist[0]?.spec).not.toMatch(/Logitech|Razer|Dell|Microsoft|Lenovo/i);
    expect(callback.clarifications).toEqual([
      expect.objectContaining({
        itemId: "item-1-computer-mouse",
        prompt: "Do you have a preferred brand?",
      }),
    ]);
  });
});

function activity(goal = "Set up my home office"): Activity {
  return {
    id: "activity-openai",
    userId: DEFAULT_USER_ID,
    title: goal,
    stage: "wishlist",
    status: "live",
    createdAt: new Date().toISOString(),
    displayTs: "now",
    messages: [{ id: "message-1", role: "user", text: goal }],
    wishlist: [],
    wishlistEstimate: "estimating…",
    clarifications: [],
    itemProgress: [],
    agents: [],
    searchPlaying: false,
    shortlist: [],
    execution: [],
    log: [],
    totalMinor: 0,
  };
}
