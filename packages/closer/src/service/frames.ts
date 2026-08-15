import type { Page } from "playwright";
import type { LiveView } from "./liveview.js";

/**
 * Feeds the live view from a CDP screencast.
 *
 * Without this the view serves its page, the browser connects to the stream, and nothing ever
 * arrives — a black rectangle that looks like a broken merchant rather than a missing wire.
 *
 * Chrome pushes a frame whenever the page changes and waits for each to be acknowledged, so an
 * idle tab costs nothing and a slow consumer throttles the source instead of drowning. Frames go
 * through `view.push`, which drops them while the view is blanked — so the card-entry window stays
 * dark without this code needing to know anything about cards.
 */
export async function attachFrames(
  page: Page,
  attemptId: string,
  view: LiveView,
): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);

  cdp.on("Page.screencastFrame", async (evt: { data: string; sessionId: number }) => {
    view.push(attemptId, evt.data);
    // Acknowledged even with nobody watching, or the stream stalls permanently.
    await cdp.send("Page.screencastFrameAck", { sessionId: evt.sessionId }).catch(() => {});
  });

  await cdp
    .send("Page.startScreencast", {
      format: "jpeg",
      quality: Number(process.env.AGENTCORE_FRAME_QUALITY ?? 70),
      maxWidth: 1600,
      maxHeight: 900,
      everyNthFrame: 1,
    })
    .catch(() => {
      /* A view that never paints must not fail a purchase that is otherwise fine. */
    });

  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  };
}
