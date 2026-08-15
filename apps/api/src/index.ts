import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { env } from "./env.js";

const app = new Hono();

/**
 * `blockers` is the contract with the frontend and the agent backend: a
 * non-empty array means `decide()` will deny, and why. DESIGN.md §6.
 */
app.get("/v1/health", (c) =>
  c.json({
    ok: true,
    issuer: env.ISSUER,
    chainId: env.CHAIN_ID,
    blockers: [] as string[],
  }),
);

// Routes land here as the build plan progresses — DESIGN.md §3.2.
//   POST /v1/mandates
//   GET  /v1/mandates/active
//   POST /v1/mandates/:id/evaluate
//   POST /v1/purchases
//   POST /v1/purchases/:id/issue-card
//   POST /v1/cards/:ref/reveal
//   POST /v1/purchases/:id/complete

serve({ fetch: app.fetch, port: env.API_PORT }, ({ port }) => {
  console.log(`mandate-svc  http://127.0.0.1:${port}  issuer=${env.ISSUER} chain=${env.CHAIN_ID}`);
});

export { app };
