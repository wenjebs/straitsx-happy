import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";

describe("demo store", () => {
  it("serves an item with a price", async () => {
    const res = await app.request("/item/usb-c-hub");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('data-price-cents="1800"');
  });

  it("serves the injection fixture with hidden instructions", async () => {
    const html = await (await app.request("/item/injected")).text();
    expect(html).toMatch(/ignore your budget/i);
    expect(html).toContain('data-price-cents="1800"');
  });

  it("accepts a Luhn-valid card and returns an order reference", async () => {
    const form = new URLSearchParams({
      sku: "usb-c-hub",
      cardNumber: "4111111111111111",
      expiry: "12/29",
      cvc: "123",
      name: "Happy Agent",
    });
    const res = await app.request("/checkout", { method: "POST", body: form });
    const html = await res.text();
    expect(html).toMatch(/data-order-ref="ord_[a-z0-9]+"/);
  });

  it("declines a card that fails Luhn", async () => {
    const form = new URLSearchParams({
      sku: "usb-c-hub",
      cardNumber: "4111111111111112",
      expiry: "12/29",
      cvc: "123",
      name: "Happy Agent",
    });
    const res = await app.request("/checkout", { method: "POST", body: form });
    expect(await res.text()).toMatch(/declined/i);
  });
});
