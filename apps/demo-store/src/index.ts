import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = Number(process.env.DEMO_STORE_PORT ?? 4030);
serve({ fetch: app.fetch, port });
console.log(`demo-store listening on :${port}`);
