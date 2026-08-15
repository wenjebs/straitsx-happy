import type { Activity, ShortlistPick, StageIndex, WishlistItem } from "../domain.js";
import { merchantById, merchantsForSlot, type VerifiedMerchant } from "../merchants.js";
import type { ScoutProvider } from "./agent.js";
import type { AgentCoreBrowser, BrowserSession } from "./agentcoreBrowser.js";
import { catalogueFallback } from "./fallbackShortlist.js";
import { relevance, type ScoutBrain, type ScoutDecision, type ScoutPick } from "./scoutBrain.js";
import { mintStreamToken } from "../streamTokens.js";
import { openProduct, searchStore } from "./storefront.js";

/**
 * The search phase, run on real browsers.
 *
 * One AgentCore session per tile. Each session is driven by the brain's tool calls, and every tool
 * call is a real navigation the viewer watches happen. Stage movement is emitted at those
 * navigations rather than on a timer, so the lane dot on the search screen is a report of what the
 * browser did, not an animation.
 *
 * Sessions cost money per minute and AgentCore allows one connection each, so a scout owns its
 * session for the length of one item and stops it explicitly when the item resolves.
 */
export interface AgentCoreScoutOptions {
  browser: AgentCoreBrowser;
  brain: ScoutBrain;
  callbackBaseUrl: string;
  callbackToken?: string;
  publicBaseUrl: string;
  slotsPerItem: number;
  maxConcurrentSessions: number;
  /** Signs the livestream capability URLs handed to the UI. */
  streamSecret: string;
  streamTokenTtlSeconds: number;
  /** Card bounds. A shortlist entry outside them cannot be paid for, so scouts never return one. */
  paymentMinMinor: number;
  paymentMaxMinor: number;
}

const STAGE_ACTIONS: Record<StageIndex, string> = {
  0: "starting a browser session",
  1: "searching the storefront",
  2: "checking seller and price",
  3: "comparing candidates",
  4: "shortlisting best fit",
};

export class AgentCoreScoutProvider implements ScoutProvider {
  readonly mode = "agentcore" as const;
  private readonly paused = new Set<string>();
  private readonly cancelled = new Map<string, AbortController>();

  constructor(private readonly options: AgentCoreScoutOptions) {}

  async dispatchSearch(activity: Activity): Promise<void> {
    this.cancelled.get(activity.id)?.abort();
    const controller = new AbortController();
    this.cancelled.set(activity.id, controller);
    void this.run(activity, controller.signal)
      .catch(async (error: unknown) => {
        if (controller.signal.aborted) return;
        await this.post(activity.id, {
          type: "run.failed",
          message: `The search agents could not finish: ${message(error)}`,
        }).catch((callbackError: unknown) => {
          console.error("AgentCore scout and its failure callback both failed", callbackError);
        });
      })
      .finally(() => {
        if (this.cancelled.get(activity.id) === controller) this.cancelled.delete(activity.id);
      });
  }

  async cancelSearch(activity: Activity): Promise<void> {
    this.cancelled.get(activity.id)?.abort();
    this.paused.delete(activity.id);
  }

  async setSearchPaused(activity: Activity, paused: boolean): Promise<void> {
    if (paused) this.paused.add(activity.id);
    else this.paused.delete(activity.id);
  }

  /**
   * Promoting an already-found alternate. Re-running the browser would cost another session and
   * another minute for a candidate the scout already opened and priced.
   */
  async rejectListing(activity: Activity, itemId: string): Promise<void> {
    const next = activity.shortlist.map((pick) => {
      if (pick.itemId !== itemId || !pick.alternates?.[0]) return pick;
      return {
        ...pick,
        listing: pick.alternates[0],
        alternates: [pick.listing, ...pick.alternates.slice(1)],
        reSearched: true,
      };
    });
    await this.post(activity.id, { type: "shortlist.ready", shortlist: next });
  }

  private async run(activity: Activity, signal: AbortSignal): Promise<void> {
    const items = activity.wishlist;
    const slots = Math.max(1, this.options.slotsPerItem);

    // Announce every tile up front, queued. The grid is then complete from the first frame and
    // tiles light up as their session comes online rather than appearing one by one.
    for (const item of items) {
      for (let slot = 0; slot < slots; slot += 1) {
        await this.post(activity.id, {
          type: "agent.update",
          agent: {
            agentId: agentId(item.id, slot),
            itemId: item.id,
            slot,
            url: merchantsForSlot(slot, slots)
              .map((merchant) => merchant.host)
              .join(" · "),
            stage: 0,
            action: "queued",
            queued: true,
          },
        });
      }
    }

    const jobs: (() => Promise<SlotResult>)[] = [];
    for (const item of items) {
      for (let slot = 0; slot < slots; slot += 1) {
        jobs.push(() => this.runSlot(activity, item, slot, slots, signal));
      }
    }

    const results = await pool(jobs, this.options.maxConcurrentSessions);
    if (signal.aborted) return;

    const shortlist: ShortlistPick[] = [];
    // Shared across the wishlist so two items never get proposed the same product.
    const used = new Set<string>();
    for (const item of items) {
      const decisions = results
        .filter((result) => result?.itemId === item.id && result.decision)
        .map((result) => (result as SlotResult).decision as ScoutDecision);
      const merged = mergeDecisions(item, decisions);
      if (merged) {
        used.add(merged.listing.url ?? merged.listing.title);
        shortlist.push({ itemId: item.id, ...merged });
        continue;
      }
      // Live scouting found nothing for this item — the shop was down, challenged, or genuinely
      // does not stock it. Fall back to the crawled catalogue so the item is still answered with a
      // real product at a real URL, rather than vanishing from the shortlist.
      const fallback = catalogueFallback(item, { used });
      if (fallback) shortlist.push({ itemId: item.id, ...fallback });
    }

    if (shortlist.length === 0) {
      await this.post(activity.id, {
        type: "run.failed",
        message:
          "No verified merchant had anything for this wishlist inside the card's spending band.",
      });
      return;
    }
    await this.post(activity.id, { type: "shortlist.ready", shortlist });
  }

  private async runSlot(
    activity: Activity,
    item: WishlistItem,
    slot: number,
    slots: number,
    signal: AbortSignal,
  ): Promise<SlotResult> {
    const id = agentId(item.id, slot);
    const merchants = merchantsForSlot(slot, slots);
    let session: BrowserSession | undefined;
    let stage: StageIndex = 0;
    let opens = 0;

    const emit = async (next: StageIndex, action: string, url: string) => {
      stage = next;
      await this.post(activity.id, {
        type: "agent.update",
        agent: {
          agentId: id,
          itemId: item.id,
          slot,
          url,
          stage: next,
          action,
          queued: false,
          liveStreamUrl: this.streamUrl(id),
        },
      });
      await this.postProgress(activity.id, item.id, next);
    };

    try {
      await this.post(activity.id, {
        type: "agent.update",
        agent: {
          agentId: id,
          itemId: item.id,
          slot,
          url: merchants.map((merchant) => merchant.host).join(" · "),
          stage: 0,
          action: STAGE_ACTIONS[0],
          queued: false,
        },
      });

      session = await this.options.browser.start(id);
      const page = session.page;

      const resolve = (merchantId: string): VerifiedMerchant => {
        const merchant = merchants.find((candidate) => candidate.id === merchantId);
        if (!merchant) {
          // The brain asked for a merchant this slot does not own. Refusing here is what keeps the
          // allowlist a property of the code.
          throw new Error(
            `${merchantId || "that merchant"} is not one of this scout's storefronts (${merchants
              .map((entry) => entry.id)
              .join(", ")}).`,
          );
        }
        return merchant;
      };

      const decision = await this.options.brain.decide({
        item: { id: item.id, name: item.name, spec: item.spec, budget: item.budget },
        merchants,
        budget: {
          minMinor: this.options.paymentMinMinor,
          maxMinor: this.options.paymentMaxMinor,
        },
        userId: activity.userId,
        signal,
        tools: {
          searchStore: async (merchantId, query) => {
            await this.waitIfPaused(activity.id, signal);
            const merchant = resolve(merchantId);
            await emit(1, `searching ${merchant.host} for "${query}"`, `${merchant.host}/search`);
            const results = await searchStore(page, merchant, query);
            if (results.length === 0) {
              // A shop that returns nothing looks identical to a shop that is challenging us or has
              // changed its search markup, and the shortlist quietly falls back either way. Say
              // which shop went quiet so the difference is diagnosable.
              console.warn(
                `scout ${id}: ${merchant.host} returned no products for "${query}"${
                  merchant.probeSparingly ? " (known to challenge repeated probing)" : ""
                }`,
              );
            }
            return results;
          },
          openProduct: async (merchantId, handle) => {
            await this.waitIfPaused(activity.id, signal);
            const merchant = resolve(merchantId);
            opens += 1;
            const next: StageIndex = opens >= 2 ? 3 : 2;
            await emit(next, STAGE_ACTIONS[next], `${merchant.host}/products/${handle}`);
            return openProduct(page, merchant, handle);
          },
        },
      });

      if (signal.aborted) return { itemId: item.id, decision: null };

      await emit(
        4,
        decision ? `picked ${decision.pick.product.title}` : "nothing here fits the band",
        decision ? new URL(decision.pick.product.url).host : merchants[0]?.host || "",
      );
      return { itemId: item.id, decision };
    } catch (error) {
      if (signal.aborted) return { itemId: item.id, decision: null };
      // One dead storefront must not take the whole search down; the other slot may still deliver.
      console.error(`scout ${id} failed`, error);
      await this.post(activity.id, {
        type: "agent.update",
        agent: {
          agentId: id,
          itemId: item.id,
          slot,
          url: merchants[0]?.host ?? "",
          stage,
          action: `stopped: ${message(error)}`.slice(0, 160),
          queued: false,
          liveStreamUrl: this.streamUrl(id),
        },
      }).catch(() => {});
      return { itemId: item.id, decision: null };
    } finally {
      await session?.close().catch(() => {});
    }
  }

  private async postProgress(activityId: string, itemId: string, stage: StageIndex): Promise<void> {
    const previous = this.lastStage.get(`${activityId}:${itemId}`) ?? 0;
    // Two slots on one item report independently; the lane shows the furthest either has reached,
    // and a genuine backward move (a scout returning to search after rejecting a product) is left
    // visible because the UI marks it as a re-check.
    this.lastStage.set(`${activityId}:${itemId}`, stage);
    await this.post(activityId, {
      type: "item.progress",
      progress: { itemId, stage, previousStage: previous as StageIndex, queued: false },
    });
  }

  private readonly lastStage = new Map<string, StageIndex>();

  private async waitIfPaused(activityId: string, signal: AbortSignal): Promise<void> {
    while (this.paused.has(activityId) && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private streamUrl(agent: string): string {
    const token = mintStreamToken(
      this.options.streamSecret,
      agent,
      this.options.streamTokenTtlSeconds,
    );
    return `${this.options.publicBaseUrl.replace(/\/$/, "")}/v1/streams/agents/${encodeURIComponent(agent)}?t=${token}`;
  }

  private async post(activityId: string, body: unknown): Promise<void> {
    const response = await fetch(
      `${this.options.callbackBaseUrl.replace(/\/$/, "")}/v1/integrations/agents/${encodeURIComponent(activityId)}/events`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.callbackToken
            ? { authorization: `Bearer ${this.options.callbackToken}` }
            : {}),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error(`Scout callback failed: ${response.status}`);
  }
}

interface SlotResult {
  itemId: string;
  decision: ScoutDecision | null;
}

function agentId(itemId: string, slot: number): string {
  return `scout-${itemId}-${slot}`;
}

/**
 * Best compliant pick across the slots that reported, with the rest kept as alternates.
 *
 * Relevance first, price second. Sorting on price alone promotes whatever is cheapest in the band —
 * which is how a search for coffee beans returns a S$7.50 packet of filter papers.
 */
function mergeDecisions(
  item: WishlistItem,
  decisions: ScoutDecision[],
): Omit<ShortlistPick, "itemId"> | null {
  const picks: ScoutPick[] = [];
  for (const decision of decisions) picks.push(decision.pick, ...decision.alternates);
  const unique = new Map<string, ScoutPick>();
  for (const pick of picks) if (!unique.has(pick.product.url)) unique.set(pick.product.url, pick);
  const score = (pick: ScoutPick) =>
    relevance(pick.product.title, item, merchantById(pick.product.merchantId)?.sells);
  const ranked = [...unique.values()].sort(
    (a, b) => score(b) - score(a) || a.product.priceMinor - b.product.priceMinor,
  );
  const [best, ...rest] = ranked;
  if (!best) return null;
  return {
    listing: toListing(best),
    reSearched: false,
    alternates: rest.slice(0, 3).map(toListing),
  };
}

function toListing(pick: ScoutPick) {
  const { product, why } = pick;
  return {
    title: product.title,
    seller: product.vendor,
    // Verified storefronts are small independents that do not publish a review count. Saying so is
    // better than the fabricated "4.8 · 1,240 reviews" the mock used to emit.
    rating: `${product.host} · verified merchant`,
    price: `S$${(product.priceMinor / 100).toFixed(2)}`,
    amountMinor: product.priceMinor,
    why,
    url: product.url,
    ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
  };
}

async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      if (job) results[index] = await job();
    }
  });
  await Promise.all(workers);
  return results;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
