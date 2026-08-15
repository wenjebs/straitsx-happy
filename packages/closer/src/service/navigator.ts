import type { Frame, Page } from "playwright";

/**
 * An LLM driving the browser, for the messy part of a checkout.
 *
 * Deterministic selectors get a product into a cart on a Shopify shop and no further. Real
 * checkouts ask for an email, a delivery method, a postal code before they quote shipping, and a
 * payment method chosen from a list that on one shop includes an option literally labelled "For
 * Internal Use (Do not select)". Encoding each shop's quirks is a losing game; describing the page
 * to a model and letting it choose the next click is not.
 *
 * ## The boundary that matters
 *
 * **The model never sees, and never types, card material.** It drives up to the point where card
 * fields exist and then stops. `typeCardInto` fills the card deterministically afterwards, with no
 * model in the loop, and the observation this file builds redacts the value of every input on the
 * page so a resumed run cannot read back a number already typed. That is CLAUDE.md invariant 10:
 * card material never reaches anywhere a model prompt could.
 *
 * Two further guards, because "the model decided to" is not an acceptable explanation for spending
 * money:
 *
 *   - It cannot navigate off the approved merchant's host. A model talked into visiting another
 *     shop is a model that buys the wrong thing.
 *   - It cannot click anything that looks like a final submit. Placing the order is the runner's
 *     decision, taken after the total has been read and checked, not the model's.
 */

export type NavAction =
  | { action: "click"; ref: number; why: string }
  | { action: "type"; ref: number; text: string; why: string }
  | { action: "select"; ref: number; value: string; why: string }
  | { action: "scroll"; dy: number; why: string }
  | { action: "done"; why: string }
  | { action: "fail"; why: string };

export type Element = {
  ref: number;
  tag: string;
  type: string;
  name: string;
  /** Present for inputs, and always redacted — see the note on card material. */
  hasValue: boolean;
  frameUrl: string;
  selector: string;
};

/** Buttons the model must never press. Placing the order is the runner's call, not the model's. */
const FORBIDDEN = /pay now|place order|complete order|confirm order|^pay$|submit order/i;

/** A payment method an operator would never choose deliberately. */
export const DECOY_PAYMENT = /do not select|internal use/i;

/**
 * Describes the page as a numbered list of things that can be interacted with.
 *
 * An accessibility-style summary rather than raw HTML or a screenshot: it is far smaller, it does
 * not carry pixels of a card, and a numbered ref is unambiguous to act on afterwards.
 */
export async function observe(page: Page): Promise<Element[]> {
  const scopes: (Page | Frame)[] = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
  const out: Element[] = [];
  let ref = 0;

  for (const scope of scopes) {
    const frameUrl = "url" in scope ? scope.url() : page.url();
    const found = await scope
      .evaluate(() => {
        type El = {
          tagName: string;
          getAttribute: (a: string) => string | null;
          textContent: string | null;
          getBoundingClientRect: () => { width: number; height: number };
        };
        const g = globalThis as unknown as {
          document: { querySelectorAll: (s: string) => ArrayLike<El> };
        };
        const nodes = Array.from(
          g.document.querySelectorAll("button, a, input, select, textarea, [role=button]"),
        ) as El[];

        return nodes
          .map((n) => {
            const box = n.getBoundingClientRect();
            return {
              tag: n.tagName.toLowerCase(),
              type: (n.getAttribute("type") ?? "").toLowerCase(),
              // What a person would call this thing. Visible text wins for buttons and links —
              // labelling a "Pay now" button "pay" from its name attribute shows the model
              // something a human would not see, and the guards read this string too.
              // The VALUE of an input is never read: on a checkout, that is the card.
              name:
                ((n.tagName === "BUTTON" || n.tagName === "A"
                  ? (n.textContent ?? "").trim() ||
                    n.getAttribute("aria-label") ||
                    n.getAttribute("name")
                  : n.getAttribute("aria-label") ||
                    n.getAttribute("placeholder") ||
                    n.getAttribute("name") ||
                    (n.textContent ?? "").trim()) ?? "").slice(0, 80),
              hasValue: Boolean(n.getAttribute("value")),
              id: n.getAttribute("id") ?? "",
              nameAttr: n.getAttribute("name") ?? "",
              width: box.width,
              height: box.height,
            };
          })
          .filter((n) => n.width > 8 && n.height > 8 && (n.name || n.nameAttr || n.id));
      })
      .catch(() => []);

    for (const f of found) {
      const selector = f.id
        ? `#${CSS_escape(f.id)}`
        : f.nameAttr
          ? `${f.tag}[name="${f.nameAttr}"]`
          : "";
      if (!selector) continue;
      out.push({
        ref: ref++,
        tag: f.tag,
        type: f.type,
        name: f.name.replace(/\s+/g, " ").slice(0, 80),
        hasValue: f.hasValue,
        frameUrl,
        selector,
      });
      if (out.length >= 120) return out;
    }
  }
  return out;
}

/** Minimal CSS.escape; the real one is not available in Node's typechecking context. */
function CSS_escape(s: string): string {
  return s.replace(/([^\w-])/g, "\\$1");
}

export type NavigatorDeps = {
  /** Asks the model for the next action. Injected so tests never call a real API. */
  decide: (prompt: string) => Promise<string>;
  log?: (m: string, d?: Record<string, unknown>) => void;
  maxSteps?: number;
};

const SYSTEM = `You drive a web browser to reach the payment step of an online checkout.

You are given a numbered list of interactive elements. Reply with ONE action as JSON, nothing else:
  {"action":"click","ref":N,"why":"..."}
  {"action":"type","ref":N,"text":"...","why":"..."}
  {"action":"select","ref":N,"value":"...","why":"..."}
  {"action":"scroll","dy":600,"why":"..."}
  {"action":"done","why":"card fields are visible"}
  {"action":"fail","why":"..."}

Rules:
- Goal: reach the step where credit card fields are shown. Then reply "done".
- NEVER click a button that places the order. Someone else does that after checking the total.
- NEVER type card numbers, expiry dates or security codes. You will never be asked to.
- Choose "Credit card" as the payment method. Never choose an option that says "do not select",
  "internal use", or an instalment/wallet provider.
- Do not change quantity or product variant. What is selected was already approved.
- Prefer the shortest path: add to cart, go to checkout, fill contact and delivery, stop.
- If the page is a bot wall or an error, reply "fail" with what it says.`;

/**
 * Drives the page until card fields exist.
 *
 * Returns when the model says done and card fields are actually present — the model's opinion is
 * not sufficient, because "done" on a page with no card field would hand the runner a page it
 * cannot fill.
 */
export async function navigateToPayment(
  page: Page,
  deps: NavigatorDeps,
  opts: { allowedHost: string; goal: string },
): Promise<void> {
  const log = deps.log ?? (() => {});
  const maxSteps = deps.maxSteps ?? 12;
  const history: string[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    if (await hasUsableCardField(page)) {
      log("navigator: card fields present", { step });
      return;
    }

    const elements = await observe(page);
    const listing = elements
      .map((e) => `[${e.ref}] <${e.tag}${e.type ? ` type=${e.type}` : ""}> ${e.name}`)
      .join("\n");

    const prompt = `${SYSTEM}

GOAL: ${opts.goal}
URL: ${page.url()}
STEP ${step} of ${maxSteps}
${history.length ? `PREVIOUS ACTIONS:\n${history.join("\n")}\n` : ""}
ELEMENTS:
${listing}

Next action as JSON:`;

    const raw = await deps.decide(prompt);
    const action = parseAction(raw);
    if (!action) {
      log("navigator: unparseable reply", { raw: raw.slice(0, 120) });
      continue;
    }

    log("navigator", { step, action: action.action, why: action.why.slice(0, 80) });

    if (action.action === "fail") throw new Error(`navigator gave up: ${action.why}`);
    if (action.action === "done") {
      // Trust but verify: a page with no card field is not done, whatever the model believes.
      if (await hasUsableCardField(page)) return;
      history.push(`said done but no card fields were present`);
      continue;
    }

    await apply(page, elements, action, opts.allowedHost);
    history.push(`${action.action} ${"ref" in action ? `[${action.ref}]` : ""} — ${action.why}`);
    await page.waitForTimeout(1500);
  }

  throw new Error(`navigator ran out of steps at ${page.url()}`);
}

async function apply(
  page: Page,
  elements: Element[],
  action: NavAction,
  allowedHost: string,
): Promise<void> {
  if (action.action === "scroll") {
    await page.mouse.wheel(0, action.dy);
    return;
  }
  if (!("ref" in action)) return;

  const el = elements.find((e) => e.ref === action.ref);
  if (!el) throw new Error(`navigator referenced element ${action.ref}, which does not exist`);

  // Placing the order is the runner's decision, taken after the total is read and checked.
  if (FORBIDDEN.test(el.name)) {
    throw new Error(`navigator tried to press "${el.name}", which places the order`);
  }
  if (DECOY_PAYMENT.test(el.name)) {
    throw new Error(`navigator tried to choose "${el.name}", which is not a real payment method`);
  }

  const scope =
    page.frames().find((f) => f.url() === el.frameUrl) ?? page.mainFrame();
  const target = scope.locator(el.selector).first();

  if (action.action === "click") {
    await target.click({ timeout: 10_000 });
    // A click can navigate. Leaving the approved merchant means buying something else.
    await page.waitForTimeout(500);
    const host = new URL(page.url()).hostname.replace(/^www\./, "");
    if (!host.endsWith(allowedHost.replace(/^www\./, ""))) {
      throw new Error(`navigator left ${allowedHost} for ${host}`);
    }
    return;
  }
  if (action.action === "type") {
    if (looksLikeCard(action.text)) {
      throw new Error("navigator tried to type something shaped like a card number");
    }
    await target.click({ timeout: 10_000 });
    await target.fill(action.text);
    return;
  }
  if (action.action === "select") {
    await target.selectOption(action.value).catch(() => {});
  }
}

/** A crude shape check. The model is told never to do this; this makes it impossible. */
export function looksLikeCard(text: string): boolean {
  const digits = text.replace(/\D/g, "");
  return digits.length >= 12 && digits.length <= 19;
}

export function parseAction(raw: string): NavAction | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as NavAction;
    return parsed?.action ? parsed : null;
  } catch {
    return null;
  }
}

async function hasUsableCardField(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const el = frame.locator('input[autocomplete="cc-number"]').first();
    if ((await el.count().catch(() => 0)) === 0) continue;
    const box = await el.boundingBox().catch(() => null);
    if (box && box.width >= 60) return true;
  }
  return false;
}
