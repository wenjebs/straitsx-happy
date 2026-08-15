import { createHash } from "node:crypto";

/**
 * Progress reports back to Happy.
 *
 * Event ids are DERIVED rather than random. Happy deduplicates on eventId, so a retry of the same
 * logical event must carry the same id — a random one would show the user "placing order" twice
 * because our first POST happened to time out.
 *
 * A callback that never lands is swallowed. The purchase already happened by then; failing to
 * narrate it does not un-happen it, and throwing here would abort a run that is mid-checkout
 * holding a live card.
 */
export type CallbackTarget = { url: string; token?: string | undefined };

/** Mirrors PurchaseAgentCallbackEvent in backend/src/schemas.ts. */
export type PurchaseEvent =
  | { type: "browser.started"; liveStreamUrl: string; message?: string }
  | { type: "checkout.prepared"; message?: string }
  | { type: "order.placing"; message?: string }
  | { type: "order.confirmed"; orderId: string; message?: string }
  | { type: "purchase.failed"; message: string; retryable?: boolean };

export function eventIdFor(attemptId: string, type: string, seq: number): string {
  return createHash("sha256").update(`${attemptId}:${type}:${seq}`).digest("hex").slice(0, 32);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendCallback(
  target: CallbackTarget,
  base: { attemptId: string; itemId: string; eventId: string },
  event: PurchaseEvent,
  opts: { attempts?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({ ...base, ...event });

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
        },
        body,
      });
      if (res.ok) return true;
    } catch {
      /* network failures retry like any other */
    }
    if (i < attempts - 1) await delay(50 * 2 ** i);
  }
  return false;
}
