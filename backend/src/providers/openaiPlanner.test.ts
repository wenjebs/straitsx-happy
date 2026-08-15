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
                          short: "lamp",
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
      text: { format: { type: string; strict: boolean } };
    };
    expect(request.store).toBe(false);
    expect(request.text.format).toMatchObject({ type: "json_schema", strict: true });
    const callback = JSON.parse(String(calls[1]?.init?.body)) as {
      type: string;
      wishlist: { id: string; short: string }[];
      clarifications: { itemId: string }[];
    };
    expect(callback.type).toBe("wishlist.ready");
    expect(callback.wishlist).toHaveLength(2);
    expect(callback.wishlist[0]).toMatchObject({ id: "item-1-desk-lamp", short: "LAMP" });
    expect(callback.clarifications[0]?.itemId).toBe("item-1-desk-lamp");
  });
});

function activity(): Activity {
  return {
    id: "activity-openai",
    userId: DEFAULT_USER_ID,
    title: "Set up my home office",
    stage: "wishlist",
    status: "live",
    createdAt: new Date().toISOString(),
    displayTs: "now",
    messages: [{ id: "message-1", role: "user", text: "Set up my home office" }],
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
