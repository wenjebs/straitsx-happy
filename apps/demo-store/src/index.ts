import { serve } from "@hono/node-server";
import { Hono } from "hono";

/**
 * Storefront the agent checks out against. Luhn-only card validation, plus the
 * order webhook that flips the activity feed to COMPLETED. DESIGN.md §3.
 */
const app = new Hono();
const PORT = Number(process.env.DEMO_STORE_PORT ?? 4030);

app.get("/health", (c) => c.json({ ok: true, service: "demo-store" }));

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`demo-store   http://127.0.0.1:${port}`);
});

export { app };
