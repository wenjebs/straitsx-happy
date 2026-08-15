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
    .catch((error: unknown) => {
      // A view that never paints must not fail a purchase that is otherwise fine — but a silent
      // catch here is indistinguishable from a broken merchant, so it says so.
      console.error(
        `live view: startScreencast failed for ${attemptId}:`,
        error instanceof Error ? error.message : error,
      );
    });

  /*
   * A screenshot every two seconds, on top of the screencast.
   *
   * Screencast frames only exist when Chrome repaints, and a checkout that has finished loading
   * repaints rarely or never — which showed up as a permanently black tile even though the run
   * was healthy. The screencast still carries the smooth updates; this guarantees the picture is
   * never older than one tick. `view.push` drops these while the view is blanked, so the
   * card-entry window stays dark.
   */
  const quality = Number(process.env.AGENTCORE_FRAME_QUALITY ?? 70);
  const paint = async () => {
    const shot = await page.screenshot({ type: "jpeg", quality, timeout: 5_000 }).catch(() => null);
    if (shot) view.push(attemptId, shot.toString("base64"));
  };
  await paint();
  const ticker = setInterval(() => void paint(), 2_000);

  return async () => {
    clearInterval(ticker);
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  };
}
