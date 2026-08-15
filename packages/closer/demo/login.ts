/**
 * Sign in once, by hand, into a browser profile the agent will reuse.
 *
 *   pnpm --filter @happy/closer login https://shop.example.sg
 *
 * A window opens. You sign in yourself — you type the password, you answer the code, you solve the
 * puzzle. The agent does none of that and never sees your password. When you press Enter, the
 * profile is saved to disk, and every later run starts already signed in.
 *
 * The profile holds live session cookies. Treat the directory like a password. It is gitignored.
 */
import { chromium } from "playwright";

const url = process.argv[2];
const dir = process.env.CLOSER_PROFILE_DIR ?? "./closer-profile";

if (!url) {
  console.error("usage: pnpm --filter @happy/closer login <url>");
  process.exit(1);
}

const context = await chromium.launchPersistentContext(dir, { headless: false });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url);

console.log(`\nprofile: ${dir}`);
console.log("Sign in in the window. Answer any code or puzzle yourself.");
console.log("Press Enter here when you are signed in.\n");
await new Promise((resolve) => process.stdin.once("data", resolve));

await context.close();
console.log(`saved. Later runs reuse ${dir} and start signed in.\n`);
