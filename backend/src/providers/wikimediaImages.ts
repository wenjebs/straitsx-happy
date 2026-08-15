export interface ResolvedOptionImage {
  imageUrl: string;
  imageSourceUrl: string;
  imageAttribution: string;
}

export type OptionImageResolver = (query: string) => Promise<ResolvedOptionImage | null>;

interface CommonsImageInfo {
  thumburl?: unknown;
  url?: unknown;
  descriptionurl?: unknown;
  mime?: unknown;
  extmetadata?: Record<string, { value?: unknown }>;
}

interface CommonsPage {
  title?: unknown;
  imageinfo?: CommonsImageInfo[];
}

/**
 * Finds a real, reusable product reference photo on Wikimedia Commons.
 * This is best-effort: a missing/slow public image service never blocks a plan.
 */
export async function resolveWikimediaImage(
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<ResolvedOptionImage | null> {
  const knownImage = knownConnectorImage(query);
  if (knownImage) return knownImage;

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: "4",
    prop: "imageinfo",
    iiprop: "url|mime|extmetadata",
    iiurlwidth: "640",
    iiextmetadatafilter: "Artist|LicenseShortName",
    iiextmetadatalanguage: "en",
    origin: "*",
  });

  try {
    const response = await fetcher(`https://commons.wikimedia.org/w/api.php?${params}`, {
      headers: { "api-user-agent": "Happy/0.1 (shopping option image enrichment)" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { query?: { pages?: CommonsPage[] } };
    for (const page of body.query?.pages ?? []) {
      const info = page.imageinfo?.[0];
      if (!info || !isBitmapMime(info.mime)) continue;
      const imageUrl = stringValue(info.thumburl) ?? stringValue(info.url);
      const imageSourceUrl = stringValue(info.descriptionurl);
      if (!imageUrl || !imageSourceUrl) continue;
      const artist = cleanMetadata(info.extmetadata?.Artist?.value);
      const licence = cleanMetadata(info.extmetadata?.LicenseShortName?.value);
      return {
        imageUrl,
        imageSourceUrl,
        imageAttribution: [artist, licence, "Wikimedia Commons"].filter(Boolean).join(" · "),
      };
    }
  } catch {
    // Image enrichment is intentionally non-critical to the shopping workflow.
  }
  return null;
}

/** Stable Commons fallbacks for the most common cable clarification. */
function knownConnectorImage(query: string): ResolvedOptionImage | null {
  if (/usb[- ]?a/i.test(query)) {
    return {
      imageUrl:
        "https://commons.wikimedia.org/wiki/Special:Redirect/file/IKEA_SITTBRUNN_USB_A_TO_C_CABLE.jpg?width=640",
      imageSourceUrl: "https://commons.wikimedia.org/wiki/File:IKEA_SITTBRUNN_USB_A_TO_C_CABLE.jpg",
      imageAttribution: "Dinkun Chen · CC BY-SA 4.0 · Wikimedia Commons",
    };
  }
  if (/usb[- ]?c/i.test(query)) {
    return {
      imageUrl:
        "https://commons.wikimedia.org/wiki/Special:Redirect/file/IKEA_SITTBRUNN_USB_C_TO_C_CABLE.jpg?width=640",
      imageSourceUrl: "https://commons.wikimedia.org/wiki/File:IKEA_SITTBRUNN_USB_C_TO_C_CABLE.jpg",
      imageAttribution: "Dinkun Chen · CC BY-SA 4.0 · Wikimedia Commons",
    };
  }
  return null;
}

function isBitmapMime(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["image/jpeg", "image/png", "image/webp", "image/avif"].includes(value)
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && /^https:\/\//.test(value) ? value : null;
}

function cleanMetadata(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
