import type { Frame, Page } from "playwright";
import { type Element, isSameSite, looksLikeCard, observe } from "./navigator.js";

/**
 * The tools a model may call to drive a checkout.
 *
 * Tool calls rather than "reply with JSON": the shape is validated by the API instead of scraped
 * out of prose with a regex, and each call's result goes back into the conversation so the model
 * sees what its last click actually did rather than guessing.
 *
 * ## Two kinds of failure, deliberately different
 *
 * A tool can fail in a way the model should fix — a stale element reference, a click that hit
 * nothing. Those come back as ordinary tool results saying what went wrong, and the model tries
 * again.
 *
 * A tool can also fail in a way that means the run must stop: pressing the button that places the
 * order, choosing a payment method labelled "do not select", typing something card-shaped, or
 * ending up on a host that is not the approved merchant. Those throw `Refused`, which aborts the
 * whole run. They are not the model's to retry, because each of them either spends money or hands
 * a card to a stranger, and "the model decided to" is not an acceptable explanation for either.
 */

export class Refused extends Error {}

/** Buttons the model must never press. Placing the order is the runner's call. */
const PLACES_ORDER = /pay now|place order|complete order|confirm order|^pay$|submit order/i;

/** A payment method no operator would choose on purpose. Polypet's checkout really offers this. */
const DECOY_PAYMENT = /do not select|internal use/i;

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export const TOOL_SCHEMA = [
  {
    type: "function",
    function: {
      name: "click",
      description:
        "Click an element from the page listing. Use for buttons, links, radio options and checkboxes.",
      parameters: {
        type: "object",
        required: ["ref", "why"],
        properties: {
          ref: { type: "integer", description: "The [n] number of the element to click" },
          why: { type: "string", description: "One short phrase: what this is meant to achieve" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description:
        "Type into a text field. Never for card numbers, expiry dates or security codes — those are entered by another system you must not touch.",
      parameters: {
        type: "object",
        required: ["ref", "text", "why"],
        properties: {
          ref: { type: "integer" },
          text: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select_option",
      description: "Choose a value in a dropdown.",
      parameters: {
        type: "object",
        required: ["ref", "value", "why"],
        properties: {
          ref: { type: "integer" },
          value: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the page to reveal more of it.",
      parameters: {
        type: "object",
        required: ["dy"],
        properties: { dy: { type: "integer", description: "Pixels; negative scrolls up" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description: "Re-read the page. Use when you are unsure what changed.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "finished",
      description: "The card fields are visible and it is time to hand over. Call this to stop.",
      parameters: {
        type: "object",
        required: ["why"],
        properties: { why: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "give_up",
      description:
        "This checkout cannot be completed — a bot wall, a required account, an error page. Say exactly what you see.",
      parameters: {
        type: "object",
        required: ["why"],
        properties: { why: { type: "string" } },
      },
    },
  },
] as const;

export type ToolOutcome =
  | { kind: "ok"; result: string }
  | { kind: "finished"; why: string }
  | { kind: "gave_up"; why: string };

function frameFor(page: Page, el: Element): Page | Frame {
  return page.frames().find((f) => f.url() === el.frameUrl) ?? page.mainFrame();
}

/**
 * Runs one tool call against the page.
 *
 * Returns a short description of what happened, which becomes the tool result the model reads
 * next. Throws `Refused` for the four things that must end the run.
 */
export async function executeTool(
  page: Page,
  elements: Element[],
  call: ToolCall,
  allowedHost: string,
): Promise<ToolOutcome> {
  const { name, args } = call;

  if (name === "finished") return { kind: "finished", why: String(args.why ?? "") };
  if (name === "give_up") return { kind: "gave_up", why: String(args.why ?? "") };

  if (name === "scroll") {
    await page.mouse.wheel(0, Number(args.dy ?? 400));
    await page.waitForTimeout(400);
    return { kind: "ok", result: "scrolled" };
  }

  if (name === "read_page") {
    return { kind: "ok", result: describe(await observe(page), page.url()) };
  }

  const ref = Number(args.ref);
  const el = elements.find((e) => e.ref === ref);
  // Recoverable: the page changed under the model. Tell it, and let it re-read.
  if (!el) return { kind: "ok", result: `no element [${ref}] on this page — call read_page` };

  if (PLACES_ORDER.test(el.name)) {
    throw new Refused(`tried to press "${el.name}", which places the order`);
  }
  if (DECOY_PAYMENT.test(el.name)) {
    throw new Refused(`tried to choose "${el.name}", which is not a real payment method`);
  }

  const target = frameFor(page, el).locator(el.selector).first();

  if (name === "click") {
    await target.click({ timeout: 10_000 }).catch((e) => {
      throw new Error(`click on [${ref}] failed: ${(e as Error).message}`);
    });
    await page.waitForTimeout(1200);
    // A click can navigate. Leaving the approved merchant means buying the wrong thing, or
    // handing the card to whoever is on the other end.
    if (!isSameSite(page.url(), allowedHost)) {
      throw new Refused(`left ${allowedHost} for ${page.url()}`);
    }
    return { kind: "ok", result: `clicked "${el.name}". Now at ${page.url()}` };
  }

  if (name === "type_text") {
    const text = String(args.text ?? "");
    if (looksLikeCard(text)) {
      throw new Refused("tried to type something shaped like a card number");
    }
    await target.click({ timeout: 10_000 }).catch(() => {});
    await target.fill(text);
    return { kind: "ok", result: `typed into "${el.name}"` };
  }

  if (name === "select_option") {
    const value = String(args.value ?? "");
    await target.selectOption(value).catch((e) => {
      throw new Error(`select on [${ref}] failed: ${(e as Error).message}`);
    });
    return { kind: "ok", result: `selected "${value}" in "${el.name}"` };
  }

  return { kind: "ok", result: `unknown tool ${name}` };
}

/** The page as the model sees it: a numbered list, no input values. */
export function describe(elements: Element[], url: string): string {
  const lines = elements.map(
    (e) => `[${e.ref}] <${e.tag}${e.type ? ` type=${e.type}` : ""}> ${e.name}`,
  );
  return `URL: ${url}\n${lines.join("\n")}`;
}
