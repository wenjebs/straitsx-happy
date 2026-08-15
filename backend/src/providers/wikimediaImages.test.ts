import { describe, expect, it } from "vitest";
import { resolveWikimediaImage } from "./wikimediaImages.js";

describe("resolveWikimediaImage", () => {
  it("returns the first bitmap thumbnail with a traceable source", async () => {
    const fetcher: typeof fetch = async (url) => {
      expect(new URL(String(url)).searchParams.get("gsrsearch")).toBe(
        "filetype:bitmap warm desk lamp",
      );
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                title: "File:Cable.svg",
                imageinfo: [{ mime: "image/svg+xml", thumburl: "https://img.test/icon.svg" }],
              },
              {
                title: "File:USB-C cable.jpg",
                imageinfo: [
                  {
                    mime: "image/jpeg",
                    thumburl: "https://img.test/cable-640.jpg",
                    descriptionurl: "https://commons.test/wiki/File:Cable.jpg",
                    extmetadata: {
                      Artist: { value: "<b>Jane Photographer</b>" },
                      LicenseShortName: { value: "CC BY-SA 4.0" },
                    },
                  },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(resolveWikimediaImage("warm desk lamp", fetcher)).resolves.toEqual({
      imageUrl: "https://img.test/cable-640.jpg",
      imageSourceUrl: "https://commons.test/wiki/File:Cable.jpg",
      imageAttribution: "Jane Photographer · CC BY-SA 4.0 · Wikimedia Commons",
    });
  });

  it("fails open when Commons is unavailable", async () => {
    const fetcher: typeof fetch = async () => new Response("down", { status: 503 });
    await expect(resolveWikimediaImage("cable", fetcher)).resolves.toBeNull();
  });

  it("uses stable real photos for USB-A and USB-C connector choices", async () => {
    const unavailable: typeof fetch = async () => new Response("down", { status: 503 });
    await expect(resolveWikimediaImage("USB-A charger end", unavailable)).resolves.toMatchObject({
      imageSourceUrl: expect.stringContaining("USB_A_TO_C_CABLE"),
      imageAttribution: expect.stringContaining("CC BY-SA 4.0"),
    });
    await expect(resolveWikimediaImage("USB-C charger end", unavailable)).resolves.toMatchObject({
      imageSourceUrl: expect.stringContaining("USB_C_TO_C_CABLE"),
      imageAttribution: expect.stringContaining("CC BY-SA 4.0"),
    });
  });
});
