/**
 * The tool-calling browser agent, and the four things it must never manage to do.
 *
 * Each guard is tested by scripting a model that tries the mistake, not by asserting the happy
 * path — "the model decided to" is not an acceptable explanation for spending money or for handing
 * a card to a stranger, so the refusals have to be demonstrated rather than assumed.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ModelClient, runBrowserAgent } from "../src/service/agent.js";
import { observe } from "../src/service/navigator.js";
import { describe as describePage } from "../src/service/tools.js";

let server: Server;
let base = "";
let browser: Browser;

// A checkout with card fields — reaching this ends the run.
const PAID = `<!doctype html><meta charset="utf-8"><title>pay</title><body>
  <input id="card" name="number" autocomplete="cc-number" style="width:320px;height:32px">
</body>`;

// No card fields, so the agent must actually consult the model.
const FORM = `<!doctype html><meta charset="utf-8"><title>details</title><body>
  <input id="email" name="email" placeholder="Email">
  <button id="next" name="next">Continue to payment</button>
  <button id="pay" name="pay">Pay now</button>
  <button id="internal" name="internal">For Internal Use (Do not select)</button>
  <a id="away" href="https://example.com/">Leave the shop</a>
</body>`;

/** Replays a scripted list of tool calls, then stops asking for anything. */
function scripted(...calls: { name: string; args: Record<string, unknown> }[]): ModelClient {
  let i = 0;
  return async () => {
    const call = calls[i++];
    if (!call) return { toolCalls: [{ id: `c${i}`, name: "give_up", args: { why: "done" } }] };
    return { toolCalls: [{ id: `c${i}`, ...call }] };
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end((req.url ?? "").includes("paid") ? PAID : FORM);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Every tool result so far. The loop appends a page description after each one. */
const toolResults = (messages: unknown[]): string[] =>
  messages
    .filter((m): m is { role: string; content: string } => (m as { role?: string })?.role === "tool")
    .map((m) => String(m.content));

const refFor = async (page: Awaited<ReturnType<Browser["newPage"]>>, pattern: RegExp) => {
  const els = await observe(page);
  const el = els.find((e) => pattern.test(e.name));
  expect(el, `no element matching ${pattern}`).toBeDefined();
  return el?.ref;
};

describe("the browser agent", () => {
  it("stops at a page that already has card fields, without asking the model", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/paid`, { waitUntil: "load" });
    let asked = 0;
    await runBrowserAgent(
      page,
      {
        model: async () => {
          asked++;
          return { toolCalls: [] };
        },
      },
      { allowedHost: "127.0.0.1", goal: "reach payment" },
    );
    expect(asked).toBe(0);
    await page.close();
  }, 60_000);

  it("types into a field and reports back what it did", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/form`, { waitUntil: "load" });
    const email = await refFor(page, /email/i);

    const model: ModelClient = async (messages) => {
      const seen = toolResults(messages);
      if (seen.length > 0) return { toolCalls: [{ id: "z", name: "give_up", args: { why: seen[0] } }] };
      return {
        toolCalls: [
          { id: "a", name: "type_text", args: { ref: email, text: "a@b.test", why: "contact" } },
        ],
      };
    };

    await expect(
      runBrowserAgent(page, { model }, { allowedHost: "127.0.0.1", goal: "reach payment" }),
    ).rejects.toThrow(/typed into/i);

    expect(await page.locator("#email").inputValue()).toBe("a@b.test");
    await page.close();
  }, 60_000);

  it("refuses to press the button that places the order", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/form`, { waitUntil: "load" });
    const pay = await refFor(page, /pay now/i);

    await expect(
      runBrowserAgent(
        page,
        { model: scripted({ name: "click", args: { ref: pay, why: "finish up" } }) },
        { allowedHost: "127.0.0.1", goal: "reach payment" },
      ),
    ).rejects.toThrow(/places the order/i);
    await page.close();
  }, 60_000);

  it("refuses the payment method labelled do-not-select", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/form`, { waitUntil: "load" });
    const decoy = await refFor(page, /internal use/i);

    await expect(
      runBrowserAgent(
        page,
        { model: scripted({ name: "click", args: { ref: decoy, why: "pay with this" } }) },
        { allowedHost: "127.0.0.1", goal: "reach payment" },
      ),
    ).rejects.toThrow(/not a real payment method/i);
    await page.close();
  }, 60_000);

  it("refuses to type anything shaped like a card number", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/form`, { waitUntil: "load" });
    const email = await refFor(page, /email/i);

    await expect(
      runBrowserAgent(
        page,
        {
          model: scripted({
            name: "type_text",
            args: { ref: email, text: "4242 4242 4242 4242", why: "card" },
          }),
        },
        { allowedHost: "127.0.0.1", goal: "reach payment" },
      ),
    ).rejects.toThrow(/card number/i);
    await page.close();
  }, 60_000);

  it("refuses to leave the approved merchant", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/form`, { waitUntil: "load" });
    const away = await refFor(page, /leave the shop/i);

    await expect(
      runBrowserAgent(
        page,
        { model: scripted({ name: "click", args: { ref: away, why: "looks promising" } }) },
        { allowedHost: "127.0.0.1", goal: "reach payment" },
      ),
    ).rejects.toThrow(/left 127\.0\.0\.1/i);
    await page.close();
  }, 60_000);

  it("keeps going when the model calls finished on a page with no card fields", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/form`, { waitUntil: "load" });

    const model: ModelClient = async (messages) => {
      const seen = toolResults(messages);
      if (seen.length > 0) return { toolCalls: [{ id: "z", name: "give_up", args: { why: seen[0] } }] };
      return { toolCalls: [{ id: "a", name: "finished", args: { why: "I think we are done" } }] };
    };

    await expect(
      runBrowserAgent(page, { model }, { allowedHost: "127.0.0.1", goal: "reach payment" }),
    ).rejects.toThrow(/no card fields/i);
    await page.close();
  }, 60_000);

  it("gives up rather than looping forever", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/form`, { waitUntil: "load" });
    await expect(
      runBrowserAgent(
        page,
        {
          model: async () => ({ toolCalls: [{ id: "s", name: "scroll", args: { dy: 100 } }] }),
          maxTurns: 3,
        },
        { allowedHost: "127.0.0.1", goal: "reach payment" },
      ),
    ).rejects.toThrow(/ran out of turns/i);
    await page.close();
  }, 60_000);

  it("never shows the model an input's value", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/paid`, { waitUntil: "load" });
    await page.locator("#card").fill("4242424242424242");

    const shown = describePage(await observe(page), page.url());
    expect(shown).not.toContain("4242");
    await page.close();
  }, 60_000);
});
