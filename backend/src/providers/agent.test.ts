import { describe, expect, it } from "vitest";
import type { Activity } from "../domain.js";
import { LocalPlannerProvider } from "./agent.js";

/** Captures the callback the planner posts instead of running a server. */
function captureWishlist(
  goal: string,
): Promise<{ wishlist: { id: string; name: string }[]; title: string }> {
  return new Promise((resolve) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      globalThis.fetch = original;
      resolve(JSON.parse(init.body));
      return { ok: true } as Response;
      // biome-ignore lint/suspicious/noExplicitAny: test double for one call
    }) as any;

    const planner = new LocalPlannerProvider({ callbackBaseUrl: "http://localhost" });
    void planner.startPlanning({
      id: "act_1",
      title: goal,
      messages: [{ id: "m1", role: "user", text: goal }],
    } as Activity);
  });
}

describe("local planner failsafe", () => {
  it("searches for what was actually typed", async () => {
    // The bug this replaced: every request returned the same hardcoded pair, so asking for
    // skincare sent the scouts after coffee and the search looked broken.
    const plan = await captureWishlist("skincare");
    expect(plan.wishlist.map((item) => item.name)).toEqual(["skincare"]);
  });

  it("splits a list into separate items", async () => {
    const plan = await captureWishlist("a notebook and some coffee beans");
    expect(plan.wishlist.map((item) => item.name)).toEqual(["notebook", "coffee beans"]);
  });

  it("strips the verb a request opens with", async () => {
    const plan = await captureWishlist("buy me a face moisturiser");
    expect(plan.wishlist.map((item) => item.name)).toEqual(["face moisturiser"]);
  });

  it("never returns an empty wishlist, which the UI cannot dispatch", async () => {
    const plan = await captureWishlist("!!");
    expect(plan.wishlist.length).toBeGreaterThan(0);
  });

  it("gives every item a distinct id", async () => {
    const plan = await captureWishlist("shampoo, conditioner, shampoo");
    const ids = plan.wishlist.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
