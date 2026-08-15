/**
 * A control plane for several AgentCore browsers at once, for the frontend's Browser Test tab.
 *
 * WHY THIS EXISTS RATHER THAN AN IFRAME. The obvious way to show a remote browser in our own UI is
 * `<iframe src={liveViewUrl}>`. That does not work, and it is worth writing down why so nobody
 * tries it again: AgentCore's live-view endpoint is an Amazon DCV transport, not a web page. A
 * plain GET on the presigned URL answers `501 Not Implemented` (measured — probe/agentcore-
 * liveview.ts), and the DCV web client that *can* speak to it is a licensed AWS download, not on
 * npm. So the only two ways to see that stream are the AWS console, or shipping the DCV SDK.
 *
 * What we do instead: drive each browser over the CDP connection we already hold, screenshot it,
 * and forward clicks and keystrokes back. Lower fidelity than DCV — a poll, not a video stream —
 * but it is the same channel `payWithCard` uses, and it scales to a wall of them.
 *
 * WHY SEVERAL. Whether a merchant admits an AWS datacentre IP is the single biggest unknown left,
 * and it is answered per merchant, not in general. Running five at once turns a slow serial
 * question into one screenful.
 *
 * WHERE THE REAL HANDOFF LIVES. For an actual 3-D Secure challenge, use the AWS console live view,
 * not this. The console gives a real keyboard at the OS level, which is what a cross-origin 3DS
 * iframe needs.
 *
 * SAFETY. Test scaffolding for `ISSUER=mock`. Anything that renders the remote screen — this
 * included — shows a card number the instant it is typed. Never point it at a session that is
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
const MAX_SLOTS = Number(process.env.AGENTCORE_MAX_SLOTS ?? 6);

const consoleUrl = `https://${REGION}.console.aws.amazon.com/bedrock-agentcore/home?region=${REGION}`;

/**
 * The merchants worth asking about, from docs/merchant-shortlist.md. The marketplaces are the
 * interesting ones — they are where a datacentre IP is most likely to be judged — and Nylon is
 * the control, already proven to admit us all the way to a Shopify card form.
 */
const PRESETS = [
  { label: "Shopee", url: "https://shopee.sg/" },
  { label: "Lazada", url: "https://www.lazada.sg/" },
  { label: "Amazon SG", url: "https://www.amazon.sg/" },
  { label: "FairPrice", url: "https://www.fairprice.com.sg/" },
  { label: "Nylon (control)", url: "https://nylon.coffee/collections/all" },
];

/** Fallback only; each slot reads its real innerWidth/innerHeight after every navigation. */
const VIEWPORT_FALLBACK = { width: 1456, height: 732 };

type Slot = {
  id: string;
  label: string;
  session: AgentCoreSession;
  page: Page;
  startedAt: string;
  viewport: { width: number; height: number };
  lastError: string | null;
};

const slots = new Map<string, Slot>();
let counter = 0;

async function refreshViewport(slot: Slot) {
  slot.viewport = await slot.page
    .evaluate(() => {
      // `globalThis` rather than `window`: this file is typechecked with Node's libs, which have no
      // DOM. The function body still runs in the page, where the two are the same object.
      const w = globalThis as unknown as { innerWidth: number; innerHeight: number };
      return { width: w.innerWidth, height: w.innerHeight };
    })
    .catch(() => VIEWPORT_FALLBACK);
}

function slotStatus(slot: Slot) {
  return {
    id: slot.id,
    label: slot.label,
    sessionId: slot.session.sessionId,
    startedAt: slot.startedAt,
    url: slot.page.url(),
    viewport: slot.viewport,
    lastError: slot.lastError,
  };
}

function listStatus() {
  return {
    consoleUrl,
    maxSlots: MAX_SLOTS,
    presets: PRESETS,
    sessions: [...slots.values()].map(slotStatus),
  };
}

async function startSlot(label: string, url: string) {
  if (slots.size >= MAX_SLOTS) throw new Error(`at most ${MAX_SLOTS} sessions at once`);
  const id = `s${++counter}`;
  const session = await startAgentCoreSession({
    profile: process.env.AWS_PROFILE ?? "happy",
    region: REGION,
    sessionTimeoutSeconds: Number(process.env.AGENTCORE_SESSION_SECONDS ?? 1800),
    name: `happy-test-${id}`,
  });
  const page = await session.newPage();
  const slot: Slot = {
    id,
    label,
    session,
    page,
    startedAt: new Date().toISOString(),
    viewport: VIEWPORT_FALLBACK,
    lastError: null,
  };
  slots.set(id, slot);

  if (url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => {
      // A merchant that refuses us is the finding, not a crash. Keep the slot so its bounce page
      // can be screenshotted and read.
      slot.lastError = `navigation failed: ${e.message}`;
    });
  }
  await refreshViewport(slot);
  return slotStatus(slot);
}

async function stopSlot(id: string) {
  const slot = slots.get(id);
  if (!slot) return listStatus();
  slots.delete(id);
  // Stop explicitly rather than letting the TTL run out — the TTL is billed.
  await slot.session.close().catch(() => {});
  return listStatus();
}

async function stopAll() {
  await Promise.all([...slots.keys()].map((id) => stopSlot(id)));
  return listStatus();
}

function requireSlot(id: string | undefined): Slot {
  const slot = id ? slots.get(id) : undefined;
  if (!slot) throw new Error(`no session ${id}`);
  return slot;
}

/** The selectors payWithCard uses, duplicated here so the report matches the real thing exactly. */
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

/** Read-only: finds and reports card fields, never types and never submits. */
async function cardFieldReport(slot: Slot) {
  const page = slot.page;
  const children = page.frames().filter((f) => f !== page.mainFrame());
  const found: Record<string, { selector: string; frame: string } | null> = {};

  for (const [field, selectors] of Object.entries(CARD_SELECTORS)) {
    found[field] = null;
    for (const sel of selectors) {
      for (const [i, scope] of [page, ...children].entries()) {
        const el = scope.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
          found[field] = {
            selector: sel,
            frame: i === 0 ? "main" : (children[i - 1]?.url() ?? "?"),
          };
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

// --- per-slot actions ---------------------------------------------------------------------------

const actions: Record<string, (slot: Slot, b: Record<string, unknown>) => Promise<unknown>> = {
  navigate: async (slot, b) => {
    await slot.page.goto(String(b.url), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await refreshViewport(slot);
    return slotStatus(slot);
  },
  click: async (slot, b) => {
    await slot.page.mouse.click(Number(b.x), Number(b.y));
    return slotStatus(slot);
  },
  // Typed, not filled — the same reason payWithCard types: instant entry with no keystrokes is a
  // named fraud signal, and this tab exists to rehearse the real path.
  type: async (slot, b) => {
    await slot.page.keyboard.type(String(b.text), { delay: 40 });
    return slotStatus(slot);
  },
  key: async (slot, b) => {
    await slot.page.keyboard.press(String(b.key));
    return slotStatus(slot);
  },
  scroll: async (slot, b) => {
    await slot.page.mouse.wheel(0, Number(b.dy ?? 0));
    return slotStatus(slot);
  },
  /** Click by accessible name. Blind coordinates do not survive a real storefront's layout. */
  clickText: async (slot, b) => {
    const name = new RegExp(String(b.text), "i");
    const target = slot.page
      .getByRole("button", { name })
      .or(slot.page.getByRole("link", { name }))
      .first();
    await target.click({ timeout: Number(b.timeout ?? 15_000) });
    await slot.page.waitForLoadState("domcontentloaded").catch(() => {});
    await refreshViewport(slot);
    return slotStatus(slot);
  },
  /** Fill by selector, searching child frames — the same traversal as payWithCard. */
  fillField: async (slot, b) => {
    const sel = String(b.selector);
    const page = slot.page;
    for (const scope of [page, ...page.frames().filter((f) => f !== page.mainFrame())]) {
      const el = scope.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click();
        await el.pressSequentially(String(b.value), { delay: 40 });
        return { ...slotStatus(slot), filled: true, selector: sel };
      }
    }
    return { ...slotStatus(slot), filled: false, selector: sel };
  },
  stop: (slot) => stopSlot(slot.id),
};

// --- http ---------------------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body));
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

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    // GET /sessions
    if (req.method === "GET" && parts[0] === "sessions" && parts.length === 1) {
      return send(res, 200, listStatus());
    }

    // POST /sessions            {label,url}
    // POST /sessions/launchAll  starts every preset at once
    // POST /sessions/stopAll
    if (req.method === "POST" && parts[0] === "sessions" && parts.length <= 2) {
      const body = await readJson(req);
      if (parts[1] === "stopAll") return send(res, 200, await stopAll());
      if (parts[1] === "launchAll") {
        // Started concurrently: five serial cold starts is a minute of staring at nothing.
        const chosen = PRESETS.slice(0, Math.min(PRESETS.length, MAX_SLOTS - slots.size));
        await Promise.allSettled(chosen.map((p) => startSlot(p.label, p.url)));
        return send(res, 200, listStatus());
      }
      if (parts.length === 1) {
        await startSlot(String(body.label ?? "session"), String(body.url ?? "https://example.com/"));
        return send(res, 200, listStatus());
      }
    }

    // GET /sessions/:id/screenshot
    if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "screenshot") {
      const slot = requireSlot(parts[1]);
      const buf = await slot.page.screenshot({ type: "jpeg", quality: 50 });
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "access-control-allow-origin": ORIGIN,
      });
      return res.end(buf);
    }

    // GET /sessions/:id/cardfields
    if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "cardfields") {
      return send(res, 200, await cardFieldReport(requireSlot(parts[1])));
    }

    // POST /sessions/:id/:action
    if (req.method === "POST" && parts[0] === "sessions" && parts.length === 3) {
      const slot = requireSlot(parts[1]);
      const action = actions[parts[2] ?? ""];
      if (!action) return send(res, 404, { error: `no action ${parts[2]}` });
      try {
        return send(res, 200, await action(slot, await readJson(req)));
      } catch (e) {
        slot.lastError = (e as Error).message;
        return send(res, 400, { error: slot.lastError, ...slotStatus(slot) });
      }
    }

    return send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
  } catch (e) {
    return send(res, 400, { error: (e as Error).message });
  }
});

// Never leave sessions billing because the process died.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopAll()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agentcore test server  http://127.0.0.1:${PORT}   (CORS: ${ORIGIN})`);
  console.log(`console live view     ${consoleUrl}`);
  console.log(`presets               ${PRESETS.map((p) => p.label).join(", ")}`);
});
