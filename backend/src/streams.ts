/**
 * Live browser frames.
 *
 * AgentCore's own live-view endpoint is an Amazon DCV connection, not a page: a plain GET returns
 * 501 and a WebSocket upgrade returns "WebSocket endpoint not found", so it cannot be dropped into
 * an iframe without shipping AWS's DCV web client. It is also a live keyboard on whatever the
 * browser is showing, which is the wrong thing to hand a viewer during card entry.
 *
 * So the frames come from CDP `Page.startScreencast` on the connection the scout already holds
 * (AgentCore allows exactly one connection per session), and are served here as
 * `multipart/x-mixed-replace` — the same MJPEG stream a webcam serves, which every browser renders
 * natively in an `<img>` or an iframe. Read-only by construction.
 *
 * Frames are never persisted. A tile that attaches late gets the last frame immediately so it does
 * not sit blank until the page next repaints.
 */
export type FrameListener = (frame: Buffer) => void;

interface Channel {
  latest: Buffer | null;
  listeners: Set<FrameListener>;
  /** Cleared when the scout finishes, so a late viewer is told the stream is over. */
  closed: boolean;
}

export class FrameHub {
  private readonly channels = new Map<string, Channel>();

  private channel(id: string): Channel {
    let channel = this.channels.get(id);
    if (!channel) {
      channel = { latest: null, listeners: new Set(), closed: false };
      this.channels.set(id, channel);
    }
    return channel;
  }

  open(id: string): void {
    const channel = this.channel(id);
    channel.closed = false;
  }

  push(id: string, frame: Buffer): void {
    const channel = this.channel(id);
    channel.latest = frame;
    for (const listener of channel.listeners) listener(frame);
  }

  /** Returns an unsubscribe function. The latest frame is delivered synchronously if there is one. */
  subscribe(id: string, listener: FrameListener): () => void {
    const channel = this.channel(id);
    channel.listeners.add(listener);
    if (channel.latest) listener(channel.latest);
    return () => {
      channel.listeners.delete(listener);
    };
  }

  isClosed(id: string): boolean {
    return this.channels.get(id)?.closed ?? false;
  }

  close(id: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.closed = true;
    channel.listeners.clear();
    // The last frame is kept deliberately: a tile that renders after the run ends shows the page
    // the scout finished on rather than going blank.
  }

  /** Drops a channel entirely, including its retained frame. */
  forget(id: string): void {
    this.channels.delete(id);
  }
}
