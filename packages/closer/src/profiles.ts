import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, chromium } from "playwright";

/**
 * One saved browser profile per merchant.
 *
 * The user signs in once, by hand, in a real window. We keep the profile directory. We never ask
 * for, receive, or store a password: the only secret here is the session cookie the shop itself
 * issued, and the user can delete it at any time.
 *
 * That cookie IS account access. The directory is created 0700 and belongs in .gitignore.
 */

export type MerchantProfile = {
  /** The merchant host, e.g. "shopee.sg". Also the directory name. */
  host: string;
  connected: boolean;
  /** When the profile was last written, as an ISO string. Null when never connected. */
  connectedAt: string | null;
};

export type ProfileStore = ReturnType<typeof createProfileStore>;

const safe = (host: string) => host.toLowerCase().replace(/[^a-z0-9.-]/g, "_");

export function createProfileStore(root = process.env.CLOSER_PROFILE_DIR ?? "./closer-profiles") {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dirFor = (host: string) => join(root, safe(host));

  return {
    root,
    dirFor,

    /** Every merchant the user has connected, for the settings screen. */
    list(): MerchantProfile[] {
      return readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({
          host: e.name,
          connected: true,
          connectedAt: new Date(statSync(join(root, e.name)).mtimeMs).toISOString(),
        }));
    },

    status(host: string): MerchantProfile {
      const dir = dirFor(host);
      if (!existsSync(dir)) return { host: safe(host), connected: false, connectedAt: null };
      return {
        host: safe(host),
        connected: true,
        connectedAt: new Date(statSync(dir).mtimeMs).toISOString(),
      };
    },

    /**
     * Opens a real window at the shop's sign-in page and waits for the human. The password, the
     * one-time code and any puzzle are all answered by the person, never by us.
     *
     * `waitFor` decides when the sign-in is finished. The CLI waits for a keypress; a server waits
     * for the user to press a button in the app.
     */
    async connect(
      host: string,
      loginUrl: string,
      waitFor: (ctx: { context: BrowserContext }) => Promise<void>,
    ) {
      const context = await chromium.launchPersistentContext(dirFor(host), { headless: false });
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(loginUrl, { waitUntil: "load", timeout: 60_000 });
        await waitFor({ context });
      } finally {
        // The profile reaches disk on close. The user may have closed the window already, which
        // closes the context too, so a second close is expected and harmless.
        await context.close().catch(() => {});
      }
      return this.status(host);
    },

    /** Forgets the session. The shop still has the account; we simply no longer hold a key to it. */
    disconnect(host: string) {
      rmSync(dirFor(host), { recursive: true, force: true });
      return this.status(host);
    },

    /** The signed-in context for one shop. The caller closes it. */
    async contextFor(host: string, opts: { headless?: boolean; slowMo?: number } = {}) {
      return chromium.launchPersistentContext(dirFor(host), {
        headless: opts.headless ?? false,
        ...(opts.slowMo === undefined ? {} : { slowMo: opts.slowMo }),
      }) as Promise<BrowserContext>;
    },
  };
}
