import type { OptionImageResolver, ResolvedOptionImage } from "./wikimediaImages.js";

interface OpenAIImageSearchOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  fallback?: OptionImageResolver;
  fetcher?: typeof fetch;
}

interface ImageSearchResult {
  type?: unknown;
  image_url?: unknown;
  thumbnail_url?: unknown;
  source_website_url?: unknown;
  caption?: unknown;
}

/**
 * Resolves clarification-card pictures from OpenAI's image-search results.
 *
 * URLs are read from the web-search tool output rather than from model-authored text, so Happy
 * never asks the model to invent an image URL. The source page is retained for the attribution
 * link rendered below each picture. Image enrichment is non-critical and falls back cleanly.
 */
export function createOpenAIImageResolver(
  options: OpenAIImageSearchOptions,
): OptionImageResolver {
  const cache = new Map<string, Promise<ResolvedOptionImage | null>>();

  return async (query) => {
    const key = query.trim().toLocaleLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;

    const pending = search(query, options).then(async (image) => {
      if (image) return image;
      return options.fallback?.(query) ?? null;
    });
    cache.set(key, pending);
    return pending;
  };
}

async function search(
  query: string,
  options: OpenAIImageSearchOptions,
): Promise<ResolvedOptionImage | null> {
  try {
    const response = await (options.fetcher ?? fetch)(
      `${options.baseUrl.replace(/\/$/, "")}/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          store: false,
          reasoning: { effort: "low" },
          include: ["web_search_call.results"],
          tools: [
            {
              type: "web_search",
              search_content_types: ["image", "text"],
              image_settings: { max_results: 3, caption: true },
              user_location: { type: "approximate", country: "SG" },
            },
          ],
          input: [
            {
              role: "system",
              content:
                "Find a clear representative product photo for a shopping choice. Use image search. Prefer an uncluttered product image from a reputable source. Do not choose diagrams, documents, logos, or unrelated lifestyle photos.",
            },
            { role: "user", content: query },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) return null;
    return firstImageResult((await response.json()) as unknown);
  } catch {
    return null;
  }
}

function firstImageResult(body: unknown): ResolvedOptionImage | null {
  if (!isObject(body) || !Array.isArray(body.output)) return null;

  for (const output of body.output) {
    if (!isObject(output) || output.type !== "web_search_call" || !Array.isArray(output.results)) {
      continue;
    }
    for (const raw of output.results) {
      if (!isObject(raw)) continue;
      const result = raw as ImageSearchResult;
      if (result.type !== "image_result") continue;
      const imageUrl = httpsUrl(result.thumbnail_url) ?? httpsUrl(result.image_url);
      const imageSourceUrl = httpsUrl(result.source_website_url);
      if (!imageUrl || !imageSourceUrl) continue;
      const source = new URL(imageSourceUrl).hostname.replace(/^www\./, "");
      const caption = cleanCaption(result.caption);
      return {
        imageUrl,
        imageSourceUrl,
        imageAttribution: [caption, source].filter(Boolean).join(" · "),
      };
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function cleanCaption(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 180) : "";
}
