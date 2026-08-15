/**
 * A tiny control plane for the AgentCore browser, for the frontend's Browser Test tab.
 *
 * WHY THIS EXISTS RATHER THAN AN IFRAME. The obvious way to show a remote browser in our own UI is
 * `<iframe src={liveViewUrl}>`. That does not work, and it is worth writing down why so nobody
 * tries it again: AgentCore's live-view endpoint is an Amazon DCV transport, not a web page. A
 * plain GET on the presigned URL answers `501 Not Implemented` (measured — probe/agentcore-
 * liveview.ts), and the DCV web client that *can* speak to it is a licensed AWS download, not on
 * npm. So the only two ways to see that stream are the AWS console, or shipping the DCV SDK.
 *
 * What we do instead: drive the browser over the CDP connection we already hold, screenshot it,
 * and forward clicks and keystrokes back. That gives an interactive view we fully control, with no
 * new dependencies. It is lower fidelity than DCV — a poll, not a video stream — but it is enough
 * to prove the session works, and it is the same channel `payWithCard` uses.
 *
 * WHERE THE REAL HANDOFF LIVES. For an actual 3-D Secure challenge, use the AWS console live view,
 * not this. This server exposes `consoleUrl` for exactly that. The console gives a real keyboard at
 * the OS level, which is what a cross-origin 3DS iframe needs.
 *
 * SAFETY. This is test scaffolding for `ISSUER=mock`. Anything that renders the remote screen —
 * this included — shows a card number the instant it is typed. Never point it at a session that is
 * mid-card-entry, and never expose this port beyond localhost.
 *
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx demo/agentcore-server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Page } from "playwright";
import { type AgentCoreSession, startAgentCoreSession } from "../src/agentcore.js";

const PORT = Number(process.env.AGENTCORE_TEST_PORT ?? 4041);
const REGION = process.env.AWS_REGION ?? "ap-southeast-1";
const ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:4040";

type State = {
  session: AgentCoreSession | null;
  page: Page | null;
  startedAt: string | null;
  lastError: string | null;
};

const state: State = { session: null, page: null, startedAt: null, lastError: null };

const consoleUrl = `https://${REGION}.console.aws.amazon.com/bedrock-agentcore/home?region=${REGION}`;

/**
 * Fallback only. The session reports 1456x819, but a screenshot comes back 1456x732 — the browser's
 * own chrome eats the difference. Mapping a click through the reported figure puts it ~10% too low,
 * so `status()` reads the live `innerWidth/innerHeight` instead and only falls back to this.
 */
const VIEWPORT_FALLBACK = { width: 1456, height: 732 };
let viewport = VIEWPORT_FALLBACK;

async function refreshViewport(page: Page) {
  viewport = await page
    .evaluate(() => {
      // `globalThis` rather than `window`: this file is typechecked with Node's libs, which have no
      // DOM. The function body still runs in the page, where the two are the same object.
      const w = globalThis as unknown as { innerWidth: number; innerHeight: number };
      return { width: w.innerWidth, height: w.innerHeight };
    })
    .catch(() => VIEWPORT_FALLBACK);
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function status() {
  return {
    running: state.session !== null,
    sessionId: state.session?.sessionId ?? null,
    startedAt: state.startedAt,
    url: state.page?.url() ?? null,
    viewport,
    consoleUrl,
    lastError: state.lastError,
  };
}

async function start(startUrl: string) {
  if (state.session) return status();
  state.lastError = null;
  const session = await startAgentCoreSession({
    profile: process.env.AWS_PROFILE ?? "happy",
    region: REGION,
    sessionTimeoutSeconds: Number(process.env.AGENTCORE_SESSION_SECONDS ?? 1800),
    name: "happy-browser-test",
  });
  state.session = session;
  state.startedAt = new Date().toISOString();
  state.page = await session.newPage();
  if (startUrl) {
    await state.page
      .goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 })
      .catch((e) => {
        state.lastError = `navigation failed: ${e.message}`;
      });
  }
  await refreshViewport(state.page);
  return status();
}

async function stop() {
  const session = state.session;
  state.session = null;
  state.page = null;
  state.startedAt = null;
  // Stop explicitly rather than letting the TTL run out — the TTL is billed.
  if (session) await session.close().catch(() => {});
  return status();
}

/** Every action needs a live page; saying so once beats eight identical guards. */
function requirePage(): Page {
  if (!state.page) throw new Error("no session — start one first");
  return state.page;
}

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  "POST /start": (b) => start(String(b.url ?? "https://example.com/")),
  "POST /stop": () => stop(),

  "POST /navigate": async (b) => {
    const page = requirePage();
    await page.goto(String(b.url), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await refreshViewport(page);
    return status();
  },

  "POST /click": async (b) => {
    const page = requirePage();
    await page.mouse.click(Number(b.x), Number(b.y));
    return status();
  },

  // Typed, not filled — the same reason payWithCard types: instant entry with no keystrokes is a
  // named fraud signal, and this tab exists to rehearse the real path.
  "POST /type": async (b) => {
    const page = requirePage();
    await page.keyboard.type(String(b.text), { delay: 40 });
    return status();
  },

  "POST /key": async (b) => {
    const page = requirePage();
    await page.keyboard.press(String(b.key));
    return status();
  },

  "POST /scroll": async (b) => {
    const page = requirePage();
    await page.mouse.wheel(0, Number(b.dy ?? 0));
    return status();
  },

  /** Click by accessible name. Blind coordinates do not survive a real storefront's layout. */
  "POST /clickText": async (b) => {
    const page = requirePage();
    const name = new RegExp(String(b.text), "i");
    const target = page.getByRole("button", { name }).or(page.getByRole("link", { name })).first();
    await target.click({ timeout: Number(b.timeout ?? 15_000) });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await refreshViewport(page);
    return status();
  },

  /** Fill a field by selector, searching child frames — same traversal as payWithCard. */
  "POST /fillField": async (b) => {
    const page = requirePage();
    const sel = String(b.selector);
    for (const scope of [page, ...page.frames().filter((f) => f !== page.mainFrame())]) {
      const el = scope.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click();
        await el.pressSequentially(String(b.value), { delay: 40 });
        return { ...status(), filled: true, selector: sel };
      }
    }
    return { ...status(), filled: false, selector: sel };
  },
};

/**
 * Reports whether a real checkout's card fields are reachable, using exactly the selectors and the
 * frame traversal `payWithCard` uses. Read-only: it finds and reports, it never types and never
 * submits. This is the question the whole AgentCore plan rests on, asked against a live merchant.
 */
const CARD_SELECTORS: Record<string, string[]> = {
  number: [
    'input[autocomplete="cc-number"]',
    'input[name*="card" i][name*="num" i]',
    'input[id*="cardnumber" i]',
    'input[name="cardNumber"]',
  ],
  expiry: ['input[autocomplete="cc-exp"]', 'input[name*="exp" i]', 'input[id*="exp" i]'],
  cvc: [
    'input[autocomplete="cc-csc"]',
    'input[name*="cvc" i]',
    'input[name*="cvv" i]',
    'input[id*="cvc" i]',
  ],
  name: ['input[autocomplete="cc-name"]', 'input[name*="cardholder" i]', 'input[name="name"]'],
};

async function cardFieldReport() {
  const page = requirePage();
  const children = page.frames().filter((f) => f !== page.mainFrame());
  const found: Record<string, { selector: string; frame: string } | null> = {};

  for (const [field, selectors] of Object.entries(CARD_SELECTORS)) {
    found[field] = null;
    for (const sel of selectors) {
      for (const [i, scope] of [page, ...children].entries()) {
        const el = scope.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
          found[field] = { selector: sel, frame: i === 0 ? "main" : (children[i - 1]?.url() ?? "?") };
          break;
        }
      }
      if (found[field]) break;
    }
  }

  return {
    url: page.url(),
    frameCount: page.frames().length,
    frameHosts: children.map((f) => {
      try {
        return new URL(f.url()).host;
      } catch {
        return f.url().slice(0, 60);
      }
    }),
    found,
    allFound: Object.values(found).every(Boolean),
  };
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    if (key === "GET /status") return send(res, 200, status());
    if (key === "GET /cardfields") return send(res, 200, await cardFieldReport());

    if (key === "GET /screenshot") {
      const page = requirePage();
      const buf = await page.screenshot({ type: "jpeg", quality: 55 });
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "access-control-allow-origin": ORIGIN,
      });
      return res.end(buf);
    }

    const handler = routes[key];
    if (!handler) return send(res, 404, { error: `no route ${key}` });
    return send(res, 200, await handler(await readJson(req)));
  } catch (e) {
    const message = (e as Error).message;
    state.lastError = message;
    return send(res, 400, { error: message, ...status() });
  }
});

// Never leave a session billing because the process died.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stop()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agentcore test server  http://127.0.0.1:${PORT}   (CORS: ${ORIGIN})`);
  console.log(`console live view     ${consoleUrl}`);
});
