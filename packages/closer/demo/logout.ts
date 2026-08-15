/** Forget a shop's session: pnpm --filter @happy/closer logout shopee.sg */
import { createProfileStore } from "../src/profiles.js";

const host = process.argv[2];
if (!host) {
  console.error("usage: pnpm --filter @happy/closer logout <host>");
  process.exit(1);
}
const p = createProfileStore().disconnect(host);
console.log(`${p.host}: ${p.connected ? "still connected" : "disconnected"}`);
