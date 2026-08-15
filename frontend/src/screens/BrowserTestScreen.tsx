import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./BrowserTestScreen.module.css";

/**
 * Test surface for the AWS AgentCore remote browsers. Development scaffolding, not product.
 *
 * It talks to packages/closer/demo/agentcore-server.ts, which holds the CDP connections. It does
 * NOT embed AgentCore's own live view: that endpoint is an Amazon DCV transport, not a web page —
 * a plain GET answers 501 — and the DCV client is a licensed AWS download rather than an npm
 * package. So this polls screenshots over CDP and forwards clicks and keystrokes back.
 *
 * Several at once, because "will this merchant admit an AWS datacentre IP" is answered per
 * merchant and not in general. Five panes turn a slow serial question into one screenful.
 *
 * For a real 3-D Secure handoff use the AWS console link, which gives a human a real OS-level
 * keyboard. That is the thing this tab cannot replace.
 */

const CONTROL_BASE = import.meta.env.VITE_AGENTCORE_URL ?? "http://127.0.0.1:4041";
const FRAME_MS = 1500;

type SessionStatus = {
  id: string;
  label: string;
  sessionId: string;
  startedAt: string;
  url: string;
  viewport: { width: number; height: number };
  lastError: string | null;
};

type ListStatus = {
  consoleUrl: string;
  maxSlots: number;
  presets: { label: string; url: string }[];
  sessions: SessionStatus[];
};

export function BrowserTestScreen() {
  const [list, setList] = useState<ListStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState("https://example.com/");
  const [focused, setFocused] = useState<string | null>(null);

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
    const json = await res.json();
    if (json.error) setError(json.error);
    if (json.sessions) setList(json as ListStatus);
    return json;
  }, []);

  const guard = useCallback(async (fn: () => Promise<unknown>) => {
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
  }, []);

  useEffect(() => {
    void guard(() => call("/sessions"));
  }, [call, guard]);

  // Poll the session list so URLs track redirects and bounces without us acting. Deliberately not
  // routed through `call`: a dropped poll must not paint an error banner over working sessions.
  useEffect(() => {
    const id = setInterval(() => {
      void fetch(`${CONTROL_BASE}/sessions`)
        .then((r) => r.json())
        .then((j: ListStatus) => j.sessions && setList(j))
        .catch(() => {});
    }, FRAME_MS);
    return () => clearInterval(id);
  }, []);

  const sessions = list?.sessions ?? [];
  const full = sessions.length >= (list?.maxSlots ?? 6);

  return (
    <div className={styles.screen}>
      <p className={styles.warning}>
        <strong>Test surface — ISSUER=mock only.</strong> Each pane renders a remote screen, so it
        shows a card number the instant one is typed. Never point one at a session that is
        mid-card-entry, and never expose the control port beyond localhost.
      </p>

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || full}
          onClick={() => void guard(() => call("/sessions/launchAll", {}))}
        >
          Launch merchant panel
        </button>
        <input
          className={styles.url}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="https://…"
          spellCheck={false}
        />
        <button
          type="button"
          disabled={busy || full}
          onClick={() =>
            void guard(() =>
              call("/sessions", { label: new URL(target).host, url: target }),
            )
          }
        >
          Add one
        </button>
        <button
          type="button"
          className={styles.danger}
          disabled={busy || sessions.length === 0}
          onClick={() => void guard(() => call("/sessions/stopAll", {}))}
        >
          Stop all ({sessions.length})
        </button>
        {list?.consoleUrl && (
          <a className={styles.consoleLink} href={list.consoleUrl} target="_blank" rel="noreferrer">
            AWS console live view →
          </a>
        )}
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {sessions.length === 0 ? (
        <div className={styles.empty}>
          No sessions. <strong>Launch merchant panel</strong> starts{" "}
          {list?.presets.map((p) => p.label).join(", ") ?? "the presets"} at once.
        </div>
      ) : (
        <div className={`${styles.grid} ${focused ? styles.gridFocused : ""}`}>
          {sessions.map((s) => (
            <Pane
              key={s.id}
              session={s}
              focused={focused === s.id}
              onFocus={() => setFocused(focused === s.id ? null : s.id)}
              onAction={(action, body) =>
                void guard(() => call(`/sessions/${s.id}/${action}`, body ?? {}))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Pane({
  session,
  focused,
  onFocus,
  onAction,
}: {
  session: SessionStatus;
  focused: boolean;
  onFocus: () => void;
  onAction: (action: string, body?: unknown) => void;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Object URLs are revoked as they are replaced, or each pane leaks a blob per tick.
  useEffect(() => {
    let alive = true;
    let current: string | null = null;

    const tick = async () => {
      try {
        const res = await fetch(`${CONTROL_BASE}/sessions/${session.id}/screenshot`, {
          cache: "no-store",
        });
        if (!res.ok || !alive) return;
        const url = URL.createObjectURL(await res.blob());
        if (!alive) return URL.revokeObjectURL(url);
        if (current) URL.revokeObjectURL(current);
        current = url;
        setFrame(url);
      } catch {
        /* a dropped frame is not worth surfacing */
      }
    };

    void tick();
    const id = setInterval(tick, FRAME_MS);
    return () => {
      alive = false;
      clearInterval(id);
      if (current) URL.revokeObjectURL(current);
    };
  }, [session.id]);

  /* Map a click on the scaled screenshot back to a pixel in the remote viewport. */
  const onFrameClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    onAction("click", {
      x: Math.round(((e.clientX - rect.left) / rect.width) * session.viewport.width),
      y: Math.round(((e.clientY - rect.top) / rect.height) * session.viewport.height),
    });
  };

  let host = session.url;
  try {
    host = new URL(session.url).host;
  } catch {
    /* about:blank and friends */
  }

  return (
    <section className={`${styles.pane} ${focused ? styles.paneFocused : ""}`}>
      <header className={styles.paneHead}>
        <span className={styles.paneLabel}>{session.label}</span>
        <span className={styles.paneHost}>{host}</span>
        <button type="button" className={styles.paneBtn} onClick={onFocus}>
          {focused ? "shrink" : "expand"}
        </button>
        <button type="button" className={styles.paneBtn} onClick={() => onAction("stop")}>
          stop
        </button>
      </header>

      {frame ? (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the screenshot IS the control surface
        <img
          ref={imgRef}
          src={frame}
          alt={session.label}
          className={styles.frame}
          onClick={onFrameClick}
        />
      ) : (
        <div className={styles.placeholder}>waiting for first frame…</div>
      )}

      <footer className={styles.paneFoot}>
        <span className={styles.paneUrl} title={session.url}>
          {session.url}
        </span>
        {session.lastError && <span className={styles.paneError}>{session.lastError}</span>}
      </footer>
    </section>
  );
}
