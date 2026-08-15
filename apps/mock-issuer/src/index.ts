import { serve } from "@hono/node-server";
import { Hono } from "hono";

/**
 * Lithic-wire-shaped local issuer. Real Luhn PANs, ASA webhook, simulate
 * auth/void/clear/return. Lets the whole rail run offline at zero cost.
 * DESIGN.md §4.4.
 */
const app = new Hono();
const PORT = Number(process.env.MOCK_ISSUER_PORT ?? 4020);

app.get("/health", (c) => c.json({ ok: true, service: "mock-issuer" }));

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`mock-issuer  http://127.0.0.1:${port}`);
});

export { app };
