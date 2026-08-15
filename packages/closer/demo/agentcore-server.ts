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
import type { CDPSession, Page } from "playwright";
import { type AgentCoreSession, startAgentCoreSession } from "../src/agentcore.js";

const PORT = Number(process.env.AGENTCORE_TEST_PORT ?? 4041);
const REGION = process.env.AWS_REGION ?? "ap-southeast-1";
const ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:4040";
const MAX_SLOTS = Number(process.env.AGENTCORE_MAX_SLOTS ?? 6);

const consoleUrl = `https://${REGION}.console.aws.amazon.com/bedrock-agentcore/home?region=${REGION}`;

/**
 * Singapore retailers running their own storefronts.
 *
 * The marketplaces are deliberately gone. Shopee and Amazon SG refuse automated browsers outright,
 * and Shopee does so from a residential IP as well as from AWS — it is judging the automation, not
 * the network, so no proxy, login or datacentre change reaches them. A shop that simply wants to
 * sell you something is the shorter path, and Nylon Coffee already proved the category works all
 * the way to a Shopify card form.
 */
const PRESETS = [
  { label: "Polypet", url: "https://polypet.com.sg/" },
  { label: "Cocomo", url: "https://cocomo.sg/" },
  { label: "Prism+", url: "https://prismplus.sg/" },
  { label: "Sweelee", url: "https://sweelee.com.sg/" },
  { label: "Nylon (control)", url: "https://nylon.coffee/collections/all" },
];

/** Fallback only; each slot reads its real innerWidth/innerHeight after every navigation. */
const VIEWPORT_FALLBACK = { width: 1456, height: 732 };

/** Frame quality for the screencast. High enough to read a checkout, small enough to keep up. */
const FRAME_QUALITY = Number(process.env.AGENTCORE_FRAME_QUALITY ?? 80);

type Slot = {
  id: string;
  label: string;
  session: AgentCoreSession;
  page: Page;
  startedAt: string;
  viewport: { width: number; height: number };
  lastError: string | null;
  /** SSE subscribers watching this slot. The screencast runs only while at least one is attached. */
  clients: Set<ServerResponse>;
  cdp: CDPSession | null;
  lastFrame: string | null;
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

/**
 * Streams the remote screen by CDP screencast rather than by polling `page.screenshot()`.
 *
 * Polling a full screenshot every 1.5s is a slideshow: each one is a round trip to Singapore, and
 * the interval has to stay long enough that requests do not pile up. `Page.startScreencast` inverts
 * it — Chrome pushes a frame whenever the page actually changes, so an idle tab costs nothing and
 * an animating one arrives at video rate. It is also the same mechanism the AWS console's own view
 * ultimately relies on.
 *
 * Frames are acknowledged individually; Chrome will not send the next one until the last is acked,
 * which is what stops a slow consumer from drowning.
 */
async function startScreencast(slot: Slot) {
  if (slot.cdp) return;
  const cdp = await slot.page.context().newCDPSession(slot.page);
  slot.cdp = cdp;

  cdp.on("Page.screencastFrame", async (evt: { data: string; sessionId: number }) => {
    slot.lastFrame = evt.data;
    const payload = `data: ${evt.data}\n\n`;
    for (const res of slot.clients) {
      // Drop rather than queue for a backed-up subscriber. At ~40fps across several panes an
      // unbounded socket buffer turns into seconds of latency and never recovers; a skipped frame
      // is invisible, a growing backlog is not.
      if (res.writableLength > 1_000_000) continue;
      res.write(payload);
    }
    // Ack even with no subscribers, or the stream stalls permanently after the last one leaves.
    await cdp.send("Page.screencastFrameAck", { sessionId: evt.sessionId }).catch(() => {});
  });

  await cdp
    .send("Page.startScreencast", {
      format: "jpeg",
      quality: FRAME_QUALITY,
      maxWidth: 1600,
      maxHeight: 900,
      everyNthFrame: 1,
    })
    .catch((e) => {
      slot.lastError = `screencast failed: ${e.message}`;
    });
}

async function stopScreencast(slot: Slot) {
  if (!slot.cdp) return;
  await slot.cdp.send("Page.stopScreencast").catch(() => {});
  await slot.cdp.detach().catch(() => {});
  slot.cdp = null;
}

/**
 * A navigation can leave the screencast attached to a target that no longer paints. Cheaper and
 * more reliable to restart it than to reason about which navigations survive.
 */
async function restartScreencast(slot: Slot) {
  if (!slot.cdp) return;
  await stopScreencast(slot);
  await startScreencast(slot);
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
    clients: new Set(),
    cdp: null,
    lastFrame: null,
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
  for (const res of slot.clients) res.end();
  slot.clients.clear();
  await stopScreencast(slot).catch(() => {});
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
    await restartScreencast(slot);
    return slotStatus(slot);
  },
  click: async (slot, b) => {
    await slot.page.mouse.click(Number(b.x), Number(b.y));
    return slotStatus(slot);
  },
  /**
   * Hover without clicking.
   *
   * reCAPTCHA and friends score the pointer's approach, not just the click that lands — arriving
   * instantly at a checkbox with no prior movement is one of the cheapest bot tells there is.
   * Forwarding the operator's real mouse travel removes it, and it makes hover menus work.
   */
  move: async (slot, b) => {
    await slot.page.mouse.move(Number(b.x), Number(b.y));
    return { ok: true };
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
  /**
   * Replays a mouse path the operator actually drew, with their own timing between points.
   *
   * A slider captcha is not really asking "did the handle reach the end" — it is asking whether
   * the motion looks like a hand. Synthesising a straight line at constant speed fails that on
   * purpose. So the browser captures the real pointer path and we replay it point for point,
   * preserving the gaps between samples. The gesture is a human's; this only transports it.
   */
  drag: async (slot, b) => {
    const path = (b.path as { x: number; y: number; dt: number }[]) ?? [];
    if (path.length < 2) throw new Error("drag needs at least two points");
    const mouse = slot.page.mouse;
    const first = path[0];
    if (!first) throw new Error("drag path is empty");

    await mouse.move(first.x, first.y);
    await mouse.down();
    for (const p of path.slice(1)) {
      // Clamped: a paused drag must not hold the connection open for a minute.
      const wait = Math.min(Math.max(p.dt, 0), 250);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await mouse.move(p.x, p.y);
    }
    await mouse.up();
    await refreshViewport(slot);
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
    await restartScreencast(slot);
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

    // GET /sessions/:id/stream — server-sent events, one JPEG per frame, base64.
    // SSE rather than a websocket so this stays dependency-free; the channel is one-way anyway,
    // since input travels back over the ordinary POST actions.
    if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "stream") {
      const slot = requireSlot(parts[1]);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "access-control-allow-origin": ORIGIN,
        "x-accel-buffering": "no",
      });
      slot.clients.add(res);
      // Seed with the last frame so a new subscriber sees the page immediately rather than waiting
      // for it to change — an idle page emits nothing at all.
      if (slot.lastFrame) res.write(`data: ${slot.lastFrame}\n\n`);
      await startScreencast(slot);

      req.on("close", () => {
        slot.clients.delete(res);
        // Leave the cast running briefly rather than tearing down on every React remount.
        if (slot.clients.size === 0) {
          setTimeout(() => {
            if (slot.clients.size === 0) void stopScreencast(slot).catch(() => {});
          }, 5000);
        }
      });
      return;
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
