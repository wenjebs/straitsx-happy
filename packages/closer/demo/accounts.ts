/** What the settings screen would show: pnpm --filter @happy/closer accounts */
import { createProfileStore } from "../src/profiles.js";

const store = createProfileStore();
const list = store.list();
console.log(`\nprofiles in ${store.root}\n`);
if (list.length === 0) console.log("  none — run `login <url>` to connect a shop\n");
for (const p of list) console.log(`  ${p.host.padEnd(24)} connected ${p.connectedAt}`);
console.log("");
