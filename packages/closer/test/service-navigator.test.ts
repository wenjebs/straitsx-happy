/**
 * The guards on the browser-driving model.
 *
 * "The model decided to" is not an acceptable explanation for spending money, so the things that
 * would cost money are made impossible rather than merely discouraged in the prompt.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isSameSite,
  looksLikeCard,
  navigateToPayment,
  observe,
  parseAction,
} from "../src/service/navigator.js";

let server: Server;
let base = "";
let browser: Browser;

const CHECKOUT = `<!doctype html><meta charset="utf-8"><title>checkout</title><body>
  <input id="email" name="email" placeholder="Email">
  <input id="card" name="number" autocomplete="cc-number" style="width:320px;height:32px">
  <button id="pay" name="pay">Pay now</button>
  <button id="internal" name="internal">For Internal Use (Do not select)</button>
  <a id="away" href="https://example.com/">Leave</a>
</body>`;

const PRODUCT = `<!doctype html><meta charset="utf-8"><title>product</title><body>
  <button id="add" name="add">Add to cart</button>
  <input id="qty" name="quantity" value="1">
</body>`;

// No card field, so the navigator must actually consult the model — which is the only way to
// exercise what happens when it proposes something forbidden.
const DANGER = `<!doctype html><meta charset="utf-8"><title>danger</title><body>
  <input id="email" name="email" placeholder="Email">
  <button id="pay" name="pay">Pay now</button>
  <button id="internal" name="internal">For Internal Use (Do not select)</button>
</body>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const url = req.url ?? "";
    res.end(url.includes("danger") ? DANGER : url.includes("checkout") ? CHECKOUT : PRODUCT);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("parsing what the model said", () => {
  it("reads an action out of a reply with prose around it", () => {
    expect(parseAction('Sure! {"action":"click","ref":2,"why":"add to cart"}')).toMatchObject({
      action: "click",
      ref: 2,
    });
  });

  it("returns null rather than guessing when there is no action", () => {
    expect(parseAction("I am not sure what to do here.")).toBeNull();
  });
});

describe("card-shaped text", () => {
  it("recognises a card number however it is spaced", () => {
    expect(looksLikeCard("4242424242424242")).toBe(true);
    expect(looksLikeCard("4242 4242 4242 4242")).toBe(true);
  });

  it("does not flag ordinary checkout input", () => {
    expect(looksLikeCard("someone@example.com")).toBe(false);
    expect(looksLikeCard("018956")).toBe(false);
  });
});

describe("staying on the approved merchant", () => {
  it("accepts the shop and its subdomains", () => {
    expect(isSameSite("https://cocomo.sg/products/x", "cocomo.sg")).toBe(true);
    expect(isSameSite("https://www.cocomo.sg/checkout", "cocomo.sg")).toBe(true);
    expect(isSameSite("https://shop.cocomo.sg/checkout", "www.cocomo.sg")).toBe(true);
  });

  /*
   * The bypass this function exists for. endsWith("cocomo.sg") also accepts "evilcocomo.sg", and
   * this check is what stands between a prompt-injected page and an attacker's checkout — where
   * typeCardInto would type a real card into their form.
   */
  it("rejects a lookalike host that merely ends with the same letters", () => {
    expect(isSameSite("https://evilcocomo.sg/checkout", "cocomo.sg")).toBe(false);
    expect(isSameSite("https://cocomo.sg.attacker.com/checkout", "cocomo.sg")).toBe(false);
    expect(isSameSite("https://notcocomo.sg/", "cocomo.sg")).toBe(false);
  });

  it("rejects anything that is not http(s)", () => {
    expect(isSameSite("javascript:alert(1)", "cocomo.sg")).toBe(false);
    expect(isSameSite("data:text/html,<h1>hi</h1>", "cocomo.sg")).toBe(false);
    expect(isSameSite("not a url", "cocomo.sg")).toBe(false);
  });
});

describe("observing a page", () => {
  it("lists interactive elements without reading any input's value", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/checkout`, { waitUntil: "load" });
    const els = await observe(page);

    expect(els.some((e) => e.name.toLowerCase().includes("email"))).toBe(true);
    // The card field may be listed — it is a thing on the page — but never with its contents.
    const serialised = JSON.stringify(els);
    expect(serialised).not.toContain("4242");
    for (const el of els) expect(el).not.toHaveProperty("value");

    await page.close();
  }, 60_000);
});

describe("guards on the driving model", () => {
  const decideOnce = (reply: string) => {
    let sent = false;
    return async () => {
      if (sent) return '{"action":"fail","why":"stop"}';
      sent = true;
      return reply;
    };
  };

  it("refuses to press the button that places the order", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/danger`, { waitUntil: "load" });
    const els = await observe(page);
    const pay = els.find((e) => /pay now/i.test(e.name));
    expect(pay).toBeDefined();

    await expect(
      navigateToPayment(
        page,
        { decide: async () => JSON.stringify({ action: "click", ref: pay?.ref, why: "finish" }) },
        { allowedHost: "127.0.0.1", goal: "reach payment" },
      ),
    ).rejects.toThrow(/places the order/i);
    await page.close();
  }, 60_000);

  it("refuses the payment method labelled do-not-select", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/danger`, { waitUntil: "load" });
    const els = await observe(page);
    const decoy = els.find((e) => /internal use/i.test(e.name));
    expect(decoy).toBeDefined();

    await expect(
      navigateToPayment(
        page,
        { decide: async () => JSON.stringify({ action: "click", ref: decoy?.ref, why: "pay" }) },
        { allowedHost: "127.0.0.1", goal: "reach payment" },
      ),
    ).rejects.toThrow(/not a real payment method/i);
    await page.close();
  }, 60_000);

  it("refuses to type anything shaped like a card number", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/danger`, { waitUntil: "load" });
    const els = await observe(page);
    const email = els.find((e) => /email/i.test(e.name));

    await expect(
      navigateToPayment(
        page,
        {
          decide: async () =>
            JSON.stringify({ action: "type", ref: email?.ref, text: "4242 4242 4242 4242", why: "x" }),
        },
        { allowedHost: "127.0.0.1", goal: "reach payment" },
      ),
    ).rejects.toThrow(/card number/i);
    await page.close();
  }, 60_000);

  it("stops when card fields are present, without asking the model anything", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/checkout`, { waitUntil: "load" });
    let asked = 0;
    await navigateToPayment(
      page,
      {
        decide: async () => {
          asked++;
          return '{"action":"fail","why":"should never be asked"}';
        },
      },
      { allowedHost: "127.0.0.1", goal: "reach payment" },
    );
    expect(asked).toBe(0);
    await page.close();
  }, 60_000);

  it("gives up rather than looping forever", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/product`, { waitUntil: "load" });
    await expect(
      navigateToPayment(
        page,
        { decide: async () => '{"action":"scroll","dy":100,"why":"looking"}', maxSteps: 2 },
        { allowedHost: "127.0.0.1", goal: "reach payment" },
      ),
    ).rejects.toThrow(/ran out of steps/i);
    await page.close();
  }, 60_000);

  it("surfaces the model's own refusal", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/product`, { waitUntil: "load" });
    await expect(
      navigateToPayment(
        page,
        { decide: decideOnce('{"action":"fail","why":"this is a bot wall"}') },
        { allowedHost: "127.0.0.1", goal: "reach payment" },
      ),
    ).rejects.toThrow(/bot wall/i);
    await page.close();
  }, 60_000);
});
