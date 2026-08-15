import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./BrowserTestScreen.module.css";

/**
 * Test surface for the AWS AgentCore remote browser. Development scaffolding, not product.
 *
 * It talks to packages/closer/demo/agentcore-server.ts, which holds the CDP connection. It does
 * NOT embed AgentCore's own live view: that endpoint is an Amazon DCV transport, not a web page —
 * a plain GET answers 501 — and the DCV client is a licensed AWS download rather than an npm
 * package. So this polls screenshots over CDP and forwards clicks and keystrokes back.
 *
 * For a real 3-D Secure handoff use the AWS console link, which gives a human a real OS-level
 * keyboard. That is the thing this tab cannot replace.
 */

const CONTROL_BASE = import.meta.env.VITE_AGENTCORE_URL ?? "http://127.0.0.1:4041";
const FRAME_MS = 1000;

type Status = {
  running: boolean;
  sessionId: string | null;
  startedAt: string | null;
  url: string | null;
  viewport: { width: number; height: number };
  consoleUrl: string;
  lastError: string | null;
};

export function BrowserTestScreen() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState("https://example.com/");
  const [typeText, setTypeText] = useState("");
  const [frame, setFrame] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const call = useCallback(async (path: string, body?: unknown) => {
    setError(null);
    // Built conditionally rather than with undefined members: the project runs
    // exactOptionalPropertyTypes, under which `body: undefined` is not the same as absent.
    const init: RequestInit =
      body === undefined
        ? { method: "GET" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          };
    const res = await fetch(`${CONTROL_BASE}${path}`, init);
    const json = (await res.json()) as Status & { error?: string };
    if (json.error) setError(json.error);
    setStatus(json);
    return json;
  }, []);

  const guard = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        setError(
          `${(e as Error).message} — is the control server running? ` +
            `AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx demo/agentcore-server.ts`,
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // Poll status once on mount so a session started in another tab shows up here.
  useEffect(() => {
    void guard(() => call("/status"));
  }, [call, guard]);

  // Screenshot loop. Object URLs are revoked as they are replaced, or the tab leaks a blob per
  // second for as long as it is open.
  useEffect(() => {
    if (!status?.running) {
      setFrame(null);
      return;
    }
    let alive = true;
    let current: string | null = null;

    const tick = async () => {
      try {
        // Status rides along with each frame so the URL line tracks the page live — a redirect, a
        // captcha bounce or a link clicked on the screenshot all change it without us acting.
        // Deliberately not routed through `call`: a dropped poll must not paint an error banner.
        void fetch(`${CONTROL_BASE}/status`)
          .then((r) => r.json())
          .then((s: Status) => alive && setStatus(s))
          .catch(() => {});

        const res = await fetch(`${CONTROL_BASE}/screenshot`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const url = URL.createObjectURL(await res.blob());
        if (!alive) return URL.revokeObjectURL(url);
        if (current) URL.revokeObjectURL(current);
        current = url;
        setFrame(url);
      } catch {
        /* a dropped frame is not worth surfacing; the status line carries real errors */
      }
    };

    void tick();
    const id = setInterval(tick, FRAME_MS);
    return () => {
      alive = false;
      clearInterval(id);
      if (current) URL.revokeObjectURL(current);
    };
  }, [status?.running]);

  /* Map a click on the scaled screenshot back to a pixel in the remote viewport. */
  const onFrameClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !status) return;
    const rect = img.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * status.viewport.width);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * status.viewport.height);
    void guard(() => call("/click", { x, y }));
  };

  const running = status?.running ?? false;

  return (
    <div className={styles.screen}>
      <p className={styles.warning}>
        <strong>Test surface — ISSUER=mock only.</strong> This renders the remote screen, so it
        shows a card number the instant one is typed. Never point it at a session that is mid-card
        entry, and never expose the control port beyond localhost.
      </p>

      <div className={styles.controls}>
        <input
          className={styles.url}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="https://…"
          spellCheck={false}
        />
        {running ? (
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => void guard(() => call("/navigate", { url: target }))}
          >
            Go
          </button>
        ) : (
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => void guard(() => call("/start", { url: target }))}
          >
            Start session
          </button>
        )}
        <button
          type="button"
          className={styles.danger}
          disabled={busy || !running}
          onClick={() => void guard(() => call("/stop"))}
        >
          Stop session
        </button>
      </div>

      <dl className={styles.meta}>
        <div>
          <dt>session</dt>
          <dd>{status?.sessionId ?? "—"}</dd>
        </div>
        <div>
          <dt>url</dt>
          <dd className={styles.truncate} title={status?.url ?? ""}>
            {status?.url ?? "—"}
          </dd>
        </div>
        <div>
          <dt>live view</dt>
          <dd>
            {status?.consoleUrl ? (
              <a href={status.consoleUrl} target="_blank" rel="noreferrer">
                AWS console →
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.viewport}>
        {frame ? (
          // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the screenshot IS the control surface
          <img
            ref={imgRef}
            src={frame}
            alt="remote browser"
            className={styles.frame}
            onClick={onFrameClick}
          />
        ) : (
          <div className={styles.placeholder}>
            {running ? "waiting for first frame…" : "no session"}
          </div>
        )}
      </div>

      <div className={styles.keyboard}>
        <input
          className={styles.url}
          value={typeText}
          onChange={(e) => setTypeText(e.target.value)}
          placeholder="text to type into the remote page"
          spellCheck={false}
          disabled={!running}
        />
        <button
          type="button"
          disabled={busy || !running || !typeText}
          onClick={() =>
            void guard(async () => {
              await call("/type", { text: typeText });
              setTypeText("");
            })
          }
        >
          Type
        </button>
        <button
          type="button"
          disabled={busy || !running}
          onClick={() => void guard(() => call("/key", { key: "Enter" }))}
        >
          Enter
        </button>
        <button
          type="button"
          disabled={busy || !running}
          onClick={() => void guard(() => call("/scroll", { dy: 400 }))}
        >
          Scroll ↓
        </button>
        <button
          type="button"
          disabled={busy || !running}
          onClick={() => void guard(() => call("/scroll", { dy: -400 }))}
        >
          Scroll ↑
        </button>
      </div>
    </div>
  );
}
