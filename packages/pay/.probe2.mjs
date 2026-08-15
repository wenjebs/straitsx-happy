import { chromium } from "playwright";
const b = await chromium.connectOverCDP(process.argv[2], { headers: { "x-api-key": process.env.SKYVERN_API_KEY } });
const ctx = b.contexts()[0]; const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto("data:text/html,<form><input autocomplete=cc-number><iframe srcdoc=\"<input autocomplete=cc-number>\"></iframe></form>");
await page.locator('input[autocomplete="cc-number"]').first().fill("4111111111111111");
console.log("top-frame typed:", await page.locator('input[autocomplete="cc-number"]').first().inputValue());
console.log("frames visible:", page.frames().length);
for (const f of page.frames().slice(1)) { const l=f.locator('input[autocomplete="cc-number"]').first(); if (await l.count()) { await l.fill("4222222222222"); console.log("child-iframe typed:", await l.inputValue()); } }
