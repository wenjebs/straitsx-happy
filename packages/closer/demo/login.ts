/**
 * Connect one shop: sign in once, by hand, into a profile the agent will reuse.
 *
 *   pnpm --filter @happy/closer login https://shopee.sg
 *
 * A window opens. You sign in yourself — you type the password, you answer the code, you solve the
 * puzzle. The agent does none of that and never sees your password. When you press Enter, the
 * session is saved under the shop's host name.
 *
 * The saved profile holds live session cookies. Treat it like a password. It is gitignored, and
 * `pnpm --filter @happy/closer logout <host>` deletes it.
 */
import { createProfileStore } from "../src/profiles.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: pnpm --filter @happy/closer login <url>");
  process.exit(1);
}

const store = createProfileStore();
const host = new URL(url).hostname;

const profile = await store.connect(host, url, async () => {
  console.log(`\nprofile: ${store.dirFor(host)}`);
  console.log("Sign in in the window. Answer any code or puzzle yourself.");
  console.log("Press Enter here when you are signed in.\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
});

console.log(`connected: ${profile.host} at ${profile.connectedAt}\n`);
process.exit(0);
