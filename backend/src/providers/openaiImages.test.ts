import { describe, expect, it, vi } from "vitest";
import { createOpenAIImageResolver } from "./openaiImages.js";

describe("createOpenAIImageResolver", () => {
  it("uses a real image-search result and retains its source page", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        include: string[];
        tools: Array<{ search_content_types: string[]; image_settings: unknown }>;
      };
      expect(request.include).toContain("web_search_call.results");
      expect(request.tools[0]).toMatchObject({
        search_content_types: ["image", "text"],
        image_settings: { max_results: 3, caption: true },
      });
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "web_search_call",
              results: [
                {
                  type: "image_result",
                  image_url: "https://images.example/coffee.jpg",
                  thumbnail_url: "https://images.example/coffee-thumb.jpg",
                  source_website_url: "https://www.roaster.example/coffee",
                  caption: "Whole coffee beans in a bag",
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const resolver = createOpenAIImageResolver({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://api.openai.test/v1/",
      fetcher,
    });

    await expect(resolver("whole coffee beans bag")).resolves.toEqual({
      imageUrl: "https://images.example/coffee-thumb.jpg",
      imageSourceUrl: "https://www.roaster.example/coffee",
      imageAttribution: "Whole coffee beans in a bag · roaster.example",
    });
  });

  it("falls back without blocking when image search is unavailable", async () => {
    const fetcher: typeof fetch = async () => new Response("unavailable", { status: 503 });
    const fallback = vi.fn(async () => ({
      imageUrl: "https://fallback.example/image.jpg",
      imageSourceUrl: "https://fallback.example/source",
      imageAttribution: "Fallback source",
    }));
    const resolver = createOpenAIImageResolver({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://api.openai.test/v1",
      fetcher,
      fallback,
    });

    await expect(resolver("ground filter coffee")).resolves.toMatchObject({
      imageUrl: "https://fallback.example/image.jpg",
    });
    expect(fallback).toHaveBeenCalledWith("ground filter coffee");
  });

  it("caches repeated option queries", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const resolver = createOpenAIImageResolver({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://api.openai.test/v1",
      fetcher,
    });

    await resolver("Coffee beans");
    await resolver(" coffee BEANS ");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
