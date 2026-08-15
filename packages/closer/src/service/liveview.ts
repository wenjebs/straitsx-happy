import type { ServerResponse } from "node:http";

/**
 * The page behind `liveStreamUrl`.
 *
 * Happy persists that URL in its event log and the frontend renders it in an iframe, so anyone who
 * can read an activity can open it. The card is typed into the same browser these frames come
 * from — so the stream is BLANKED from just before the card is revealed until after submit. That
 * is invariant 10 applied to pixels rather than to code paths: the number never reaches a frame
 * the frontend could render, nor whoever reopens the URL later.
 *
 * AgentCore's own live view cannot serve this. Its endpoint is an Amazon DCV transport that
 * answers 501 to a plain GET, and the DCV client is a licensed AWS download rather than an npm
 * package — measured, see docs/agentcore-browser.md.
 */
export interface LiveView {
  page(attemptId: string): string;
  attach(attemptId: string, res: ServerResponse): void;
  push(attemptId: string, jpegBase64: string): void;
  blank(attemptId: string, reason: string): void;
  resume(attemptId: string): void;
  isBlanked(attemptId: string): boolean;
  close(attemptId: string): void;
}

type Channel = { clients: Set<ServerResponse>; blanked: boolean };

/**
 * Attempt ids reach this file straight from the URL path of an unauthenticated route, and get
 * interpolated into a <script> block. Without this an id containing `</script>` executes attacker
 * script in the live view's own origin — and that page is precisely the thing that blanks during
 * card entry, so injected script could re-enable frame rendering and read the card number off the
 * canvas. Happy's ids are `attempt_...`, so a conservative whitelist costs nothing.
 */
export const ATTEMPT_ID = /^[A-Za-z0-9_-]{1,160}$/;

export function isValidAttemptId(id: string): boolean {
  return ATTEMPT_ID.test(id);
}

/** Belt and braces alongside the whitelist: keeps a literal from closing the script element. */
function safeJson(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

export function createLiveView(): LiveView {
  const channels = new Map<string, Channel>();

  const channel = (id: string): Channel => {
    let c = channels.get(id);
    if (!c) {
      c = { clients: new Set(), blanked: false };
      channels.set(id, c);
    }
    return c;
  };

  const emit = (id: string, line: string) => {
    for (const res of channel(id).clients) {
      // Drop rather than queue for a backed-up subscriber: an unbounded buffer becomes seconds of
      // latency that never recovers, and a skipped frame is invisible.
      if (res.writableLength > 1_000_000) continue;
      res.write(line);
    }
  };

  return {
    page: (attemptId) => `<!doctype html>
<meta charset="utf-8">
<title>Closer live view</title>
<style>
  html,body{margin:0;background:#0d0d10;color:#e7e7ea;font:13px system-ui,sans-serif;height:100%}
  #wrap{display:flex;align-items:center;justify-content:center;height:100%}
  canvas{max-width:100%;max-height:100%;display:block}
  #msg{position:fixed;inset:0;display:none;align-items:center;justify-content:center;
       text-align:center;padding:24px;background:#0d0d10;color:#9a9aa2}
</style>
<div id="wrap"><canvas id="c"></canvas></div>
<div id="msg"></div>
<script>
  var attemptId = ${safeJson(attemptId)};
  var c = document.getElementById('c'), ctx = c.getContext('2d'), msg = document.getElementById('msg');
  var es = new EventSource('/v1/live/' + encodeURIComponent(attemptId) + '/stream');
  es.addEventListener('frame', function (e) {
    var img = new Image();
    img.onload = function () {
      if (c.width !== img.width || c.height !== img.height) { c.width = img.width; c.height = img.height; }
      ctx.drawImage(img, 0, 0);
    };
    img.src = 'data:image/jpeg;base64,' + e.data;
  });
  es.addEventListener('blank', function (e) { msg.textContent = e.data; msg.style.display = 'flex'; });
  es.addEventListener('resume', function () { msg.style.display = 'none'; });
</script>`,

    attach(attemptId, res) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      const c = channel(attemptId);
      c.clients.add(res);
      // A viewer who joins mid-blank must see the blank, not the last frame before it.
      if (c.blanked) res.write("event: blank\ndata: card entry in progress\n\n");
      res.on("close", () => c.clients.delete(res));
    },

    push(attemptId, jpegBase64) {
      if (channel(attemptId).blanked) return;
      emit(attemptId, `event: frame\ndata: ${jpegBase64}\n\n`);
    },

    blank(attemptId, reason) {
      channel(attemptId).blanked = true;
      emit(attemptId, `event: blank\ndata: ${reason}\n\n`);
    },

    resume(attemptId) {
      channel(attemptId).blanked = false;
      emit(attemptId, "event: resume\ndata: ok\n\n");
    },

    isBlanked: (attemptId) => channel(attemptId).blanked,

    close(attemptId) {
      for (const res of channel(attemptId).clients) res.end();
      channels.delete(attemptId);
    },
  };
}
