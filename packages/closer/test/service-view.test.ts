import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { eventIdFor, sendCallback } from "../src/service/callbacks.js";
import { createLiveView } from "../src/service/liveview.js";

const target = { url: "https://happy.test/events", token: "cb-secret" };
const base = { attemptId: "attempt_1", itemId: "item-1", eventId: "e1" };

describe("callbacks", () => {
  it("derives a stable id per logical event, and different ids across events", () => {
    expect(eventIdFor("attempt_1", "order.placing", 3)).toBe(
      eventIdFor("attempt_1", "order.placing", 3),
    );
    expect(eventIdFor("attempt_1", "order.placing", 3)).not.toBe(
      eventIdFor("attempt_1", "order.confirmed", 3),
    );
  });

  it("posts the bearer token, the base fields and the event body", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await sendCallback(
      target,
      base,
      { type: "order.confirmed", orderId: "ORD-1" },
      { fetchImpl },
    );

    expect(ok).toBe(true);
    expect(seen[0]?.url).toBe("https://happy.test/events");
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer cb-secret");
    expect(JSON.parse(String(seen[0]?.init.body))).toMatchObject({
      eventId: "e1",
      attemptId: "attempt_1",
      itemId: "item-1",
      type: "order.confirmed",
      orderId: "ORD-1",
    });
  });

  // Happy deduplicates on eventId, so a retry must reuse it or the user sees the step twice.
  it("retries with the same id, then gives up without throwing", async () => {
    const ids: string[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      ids.push(JSON.parse(String(init?.body)).eventId);
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const ok = await sendCallback(target, base, { type: "order.placing" }, { attempts: 3, fetchImpl });
    expect(ok).toBe(false);
    expect(ids).toEqual(["e1", "e1", "e1"]);
  });
});

function fakeRes() {
  const chunks: string[] = [];
  const res = {
    writeHead: () => {},
    write: (s: string) => chunks.push(s),
    end: () => {},
    writableLength: 0,
    on: () => {},
  } as unknown as ServerResponse;
  return { chunks, res };
}

describe("live view", () => {
  it("serves a page that streams the attempt", () => {
    const html = createLiveView().page("attempt_1");
    expect(html).toContain("<canvas");
    expect(html).toContain("attempt_1");
  });

  it("pushes frames to an attached subscriber", () => {
    const view = createLiveView();
    const { chunks, res } = fakeRes();
    view.attach("attempt_1", res);
    view.push("attempt_1", "AAAA");
    expect(chunks.join("")).toContain("AAAA");
  });

  // The card is typed into the browser these frames come from. This is the test that keeps the
  // number off the frontend.
  it("drops frames while blanked and delivers again after resume", () => {
    const view = createLiveView();
    const { chunks, res } = fakeRes();
    view.attach("attempt_1", res);

    view.blank("attempt_1", "card entry in progress");
    view.push("attempt_1", "SECRETFRAME");
    expect(chunks.join("")).not.toContain("SECRETFRAME");
    expect(view.isBlanked("attempt_1")).toBe(true);

    view.resume("attempt_1");
    view.push("attempt_1", "VISIBLEFRAME");
    expect(chunks.join("")).toContain("VISIBLEFRAME");
    expect(view.isBlanked("attempt_1")).toBe(false);
  });

  it("tells a viewer who joins mid-blank that it is blanked", () => {
    const view = createLiveView();
    view.blank("attempt_1", "card entry in progress");
    const { chunks, res } = fakeRes();
    view.attach("attempt_1", res);
    expect(chunks.join("")).toContain("event: blank");
  });

  it("keeps attempts independent", () => {
    const view = createLiveView();
    const a = fakeRes();
    const b = fakeRes();
    view.attach("attempt_a", a.res);
    view.attach("attempt_b", b.res);
    view.blank("attempt_a", "card entry in progress");
    view.push("attempt_a", "HIDDEN");
    view.push("attempt_b", "SHOWN");
    expect(a.chunks.join("")).not.toContain("HIDDEN");
    expect(b.chunks.join("")).toContain("SHOWN");
  });
});
