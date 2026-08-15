/**
 * Console tracing for the deployed app.
 *
 * On by default, because the thing this exists for is a demo going wrong on someone else's laptop
 * with no way to rebuild. Turn it off from the console with `happy.debug(false)` — the choice is
 * remembered — or with `?debug=0` in the URL.
 *
 * Never log a card number, a token or an address' contents. This traces which call was made and
 * what came back, not what the payload held.
 */
const STORAGE_KEY = "happy.debug";

const REDACTED = ["token", "authorization", "pan", "cvc", "password", "signature", "privateKey"];

let enabled = readInitialSetting();

function readInitialSetting(): boolean {
  if (typeof window === "undefined") return false;
  const fromUrl = new URLSearchParams(window.location.search).get("debug");
  if (fromUrl === "0") return false;
  if (fromUrl === "1") return true;
  return window.localStorage.getItem(STORAGE_KEY) !== "off";
}

/** Strips anything that could carry a credential before it reaches the console. */
function safe(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(safe);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED.some((word) => key.toLowerCase().includes(word.toLowerCase()))
      ? "[redacted]"
      : safe(inner);
  }
  return out;
}

const style = {
  api: "color:#7c5cff;font-weight:600",
  ok: "color:#1a7f37;font-weight:600",
  fail: "color:#c0392b;font-weight:600",
  sse: "color:#0969da;font-weight:600",
};

export const debug = {
  get on(): boolean {
    return enabled;
  },

  set(next: boolean): boolean {
    enabled = next;
    window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    console.log(`%chappy%c debug logging ${next ? "on" : "off"}`, style.api, "");
    return next;
  },

  /** One API call, with its status and how long it took. */
  request(method: string, path: string, status: number, ms: number, body?: unknown): void {
    if (!enabled) return;
    const ok = status >= 200 && status < 400;
    console.groupCollapsed(
      `%c${method}%c ${path} %c${status}%c ${Math.round(ms)}ms`,
      style.api,
      "",
      ok ? style.ok : style.fail,
      "color:#888",
    );
    if (body !== undefined) console.log(safe(body));
    console.groupEnd();
  },

  /** One server-sent event on an activity stream. */
  event(activityId: string, type: string, payload: unknown): void {
    if (!enabled) return;
    console.groupCollapsed(`%cSSE%c ${type} %c${activityId}`, style.sse, "", "color:#888");
    console.log(safe(payload));
    console.groupEnd();
  },

  /** Stream lifecycle: connecting, open, retrying. */
  stream(activityId: string, state: string): void {
    if (!enabled) return;
    console.log(`%cSSE%c ${state} — ${activityId}`, style.sse, "color:#888");
  },

  error(where: string, error: unknown): void {
    if (!enabled) return;
    console.error(`%chappy%c ${where}`, style.fail, "", error);
  },

  /** Which rail the backend is on, printed once at startup. */
  rail(health: Record<string, unknown>): void {
    const network = health.network as Record<string, unknown> | undefined;
    const real = network?.realMoney === true;
    console.log(
      `%c${real ? "MAINNET · REAL MONEY" : "TESTNET"}%c chain ${network?.chainId ?? "?"} · issuer ${network?.issuer ?? "?"} · cards ${network?.cardApi ?? "?"} · scouts ${health.scoutProvider} · closer ${health.purchaseAgentProvider}`,
      real ? "color:#fff;background:#c0392b;padding:2px 6px;border-radius:3px;font-weight:700" : "color:#fff;background:#1a7f37;padding:2px 6px;border-radius:3px;font-weight:700",
      "color:#888",
    );
  },
};

if (typeof window !== "undefined") {
  (window as unknown as { happy: unknown }).happy = {
    debug: (next = true) => debug.set(next),
  };
}
