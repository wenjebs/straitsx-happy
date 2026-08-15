import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./BrowserTestScreen.module.css";

/**
 * Test surface for the AWS AgentCore remote browsers. Development scaffolding, not product.
 *
 * It talks to packages/closer/demo/agentcore-server.ts, which holds the CDP connections. It does
 * NOT embed AgentCore's own live view: that endpoint is an Amazon DCV transport, not a web page —
 * a plain GET answers 501 — and the DCV client is a licensed AWS download rather than an npm
 * package. So the server runs a CDP screencast, streams the frames here over SSE, and this
 * forwards clicks, drags and keystrokes back.
 *
 * Several at once, because "will this merchant admit an AWS datacentre IP" is answered per
 * merchant and not in general. Five panes turn a slow serial question into one screenful.
 *
 * For a real 3-D Secure handoff use the AWS console link, which gives a human a real OS-level
 * keyboard. That is the thing this tab cannot replace.
 */

const CONTROL_BASE = import.meta.env.VITE_AGENTCORE_URL ?? "http://127.0.0.1:4041";
/** Only the session list is polled now; frames arrive pushed over SSE. */
const STATUS_MS = 2000;

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
    }, STATUS_MS);
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
  const [frame, setFrame] = useState(false);
  const [text, setText] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /*
   * Frames arrive pushed, not polled. The server runs a CDP screencast and forwards each JPEG over
   * SSE, so the pane updates whenever the page actually changes rather than on a timer — an idle
   * tab costs nothing and an animating one arrives at video rate.
   *
   * Frames are painted to a canvas rather than swapped into an <img> src: assigning src decodes
   * asynchronously and the element blanks between frames, which at this rate reads as flicker.
   */
  useEffect(() => {
    const es = new EventSource(`${CONTROL_BASE}/sessions/${session.id}/stream`);
    let alive = true;

    es.onmessage = (e) => {
      if (!alive) return;
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current;
        if (!canvas || !alive) return;
        if (canvas.width !== img.width || canvas.height !== img.height) {
          canvas.width = img.width;
          canvas.height = img.height;
        }
        canvas.getContext("2d")?.drawImage(img, 0, 0);
        setFrame(true);
      };
      img.src = `data:image/jpeg;base64,${e.data}`;
    };

    return () => {
      alive = false;
      es.close();
    };
  }, [session.id]);

  // Taking over should put the keyboard in the page immediately, without a second click.
  useEffect(() => {
    if (focused) canvasRef.current?.focus();
  }, [focused]);

  /* Map a point on the scaled screenshot back to a pixel in the remote viewport. */
  const toRemote = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * session.viewport.width),
      y: Math.round(((clientY - rect.top) / rect.height) * session.viewport.height),
    };
  };

  /*
   * Press, move, release — captured as a real path rather than reduced to two endpoints.
   *
   * A slider captcha judges the shape and timing of the motion, not just where it ended, so a
   * synthesised straight line fails by design. Recording the operator's own pointer samples and
   * their spacing keeps the gesture human, because it is one. A press that never moves is sent as
   * an ordinary click.
   */
  const drag = useRef<{ x: number; y: number; t: number }[] | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toRemote(e.clientX, e.clientY);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = [{ ...p, t: e.timeStamp }];
  };

  /* Hover forwarding, throttled. Off unless this pane has been taken over, because five panes each
   * streaming pointer moves is a lot of chatter for no benefit. */
  const lastMove = useRef(0);

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) {
      if (!focused) return;
      // ~25/s is enough for a captcha to see a human approach without flooding the connection.
      if (e.timeStamp - lastMove.current < 40) return;
      lastMove.current = e.timeStamp;
      const p = toRemote(e.clientX, e.clientY);
      if (p) onAction("move", p);
      return;
    }
    const p = toRemote(e.clientX, e.clientY);
    // Cap the sample count: a slow drag can emit hundreds, and the replay would crawl.
    if (p && drag.current.length < 120) drag.current.push({ ...p, t: e.timeStamp });
  };

  /*
   * Real keyboard capture while taken over, so typing goes straight through instead of via the
   * text box below. Printable characters are typed; everything else is forwarded by name, which is
   * what Playwright's `keyboard.press` expects.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!focused) return;
    e.preventDefault();
    const k = e.key;
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      onAction("type", { text: k });
      return;
    }
    const named: Record<string, string> = {
      Enter: "Enter",
      Backspace: "Backspace",
      Tab: "Tab",
      Escape: "Escape",
      ArrowUp: "ArrowUp",
      ArrowDown: "ArrowDown",
      ArrowLeft: "ArrowLeft",
      ArrowRight: "ArrowRight",
      Delete: "Delete",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      " ": "Space",
    };
    const mapped = named[k];
    if (mapped) onAction("key", { key: mapped });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const path = drag.current;
    drag.current = null;
    if (!path?.length) return;
    const start = path[0];
    const end = path[path.length - 1];
    if (!start || !end) return;

    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    if (moved < 5 || path.length < 2) {
      onAction("click", { x: start.x, y: start.y });
      return;
    }
    onAction("drag", {
      path: path.map((p, i) => ({
        x: p.x,
        y: p.y,
        dt: i === 0 ? 0 : Math.round(p.t - (path[i - 1]?.t ?? p.t)),
      })),
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
          {focused ? "release" : "take over"}
        </button>
        <button type="button" className={styles.paneBtn} onClick={() => onAction("stop")}>
          stop
        </button>
      </header>

      {/* tabIndex makes the canvas focusable so it can receive real key events while taken over. */}
      <canvas
        ref={canvasRef}
        className={`${styles.frame} ${focused ? styles.frameLive : ""}`}
        style={frame ? undefined : { display: "none" }}
        tabIndex={focused ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      />
      {!frame && <div className={styles.placeholder}>waiting for first frame…</div>}

      <div className={styles.paneKeys}>
        <input
          className={styles.paneInput}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="click the page first, then type here"
          spellCheck={false}
          onKeyDown={(e) => {
            // Enter sends the text and then a real Enter keypress, which is what a search box
            // wants. Without this you would have to reach for two buttons for every query.
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (text) onAction("type", { text });
            onAction("key", { key: "Enter" });
            setText("");
          }}
        />
        <button
          type="button"
          className={styles.paneBtn}
          disabled={!text}
          onClick={() => {
            onAction("type", { text });
            setText("");
          }}
        >
          type
        </button>
        <button
          type="button"
          className={styles.paneBtn}
          onClick={() => onAction("key", { key: "Enter" })}
        >
          ⏎
        </button>
        <button
          type="button"
          className={styles.paneBtn}
          onClick={() => onAction("scroll", { dy: 400 })}
        >
          ↓
        </button>
        <button
          type="button"
          className={styles.paneBtn}
          onClick={() => onAction("scroll", { dy: -400 })}
        >
          ↑
        </button>
      </div>

      <footer className={styles.paneFoot}>
        <span className={styles.paneUrl} title={session.url}>
          {session.url}
        </span>
        {session.lastError && <span className={styles.paneError}>{session.lastError}</span>}
      </footer>
    </section>
  );
}
