import type { Activity } from "../domain.js";
import { HttpError } from "../errors.js";
import { STUB_LISTINGS } from "./stubListings.js";

export interface PlannerProvider {
  readonly mode: "local" | "remote" | "openai" | "disabled";
  startPlanning(activity: Activity): Promise<void>;
  cancelPlanning?(activity: Activity): Promise<void>;
}

export interface ScoutProvider {
  readonly mode: "local" | "remote" | "disabled";
  dispatchSearch(activity: Activity): Promise<void>;
  setSearchPaused(activity: Activity, paused: boolean): Promise<void>;
  rejectListing(activity: Activity, itemId: string): Promise<void>;
  cancelSearch?(activity: Activity): Promise<void>;
}

export interface AgentProvider extends PlannerProvider, ScoutProvider {
  readonly mode: "local" | "remote" | "disabled";
}

interface LocalAgentOptions {
  callbackBaseUrl: string;
  callbackToken?: string;
}

/** Local Scout/curator that exercises the authenticated callback and SSE path. */
export class LocalAgentProvider implements AgentProvider {
  readonly mode = "local" as const;
  private readonly paused = new Set<string>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly options: LocalAgentOptions) {}

  async startPlanning(activity: Activity): Promise<void> {
    this.cancelled.delete(activity.id);
    void this.after(700, activity.id, {
      type: "wishlist.ready",
      title: "Everyday desk essentials",
      reply:
        "I turned that into two low-value items so you can safely walk through the complete local agent and purchase flow.",
      wishlistEstimate: "est. S$43.80",
      wishlist: [
        {
          id: "usb-c-cable",
          name: "Braided USB-C cable",
          short: "CABLE",
          spec: "USB-C to USB-C · 100W · 2m",
          budget: "up to S$20",
          hueIndex: 0,
          category: "Electronics",
        },
        {
          id: "phone-stand",
          name: "Adjustable phone stand",
          short: "STAND",
          spec: "foldable · aluminium · desk use",
          budget: "up to S$25",
          hueIndex: 1,
          category: "Electronics",
        },
      ],
      clarifications: [],
    });
  }

  async cancelPlanning(activity: Activity): Promise<void> {
    this.cancelled.add(activity.id);
  }

  async dispatchSearch(activity: Activity): Promise<void> {
    this.cancelled.delete(activity.id);
    void this.runSearch(activity);
  }

  async cancelSearch(activity: Activity): Promise<void> {
    this.cancelled.add(activity.id);
    this.paused.delete(activity.id);
  }

  async setSearchPaused(activity: Activity, paused: boolean): Promise<void> {
    if (paused) this.paused.add(activity.id);
    else this.paused.delete(activity.id);
  }

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
    void this.after(800, activity.id, { type: "shortlist.ready", shortlist: next });
  }

  private async runSearch(activity: Activity): Promise<void> {
    for (const item of activity.wishlist) {
      for (const slot of [0, 1] as const) {
        if (this.cancelled.has(activity.id)) return;
        await this.post(activity.id, {
          type: "agent.update",
          agent: {
            agentId: `local-scout-${item.id}-${slot}`,
            itemId: item.id,
            slot,
            url: slot === 0 ? "local.market/search" : "local.specialist/search",
            stage: 0,
            action: "launching local browser",
            queued: false,
            liveStreamUrl: this.streamUrl(`scout-${item.id}-${slot}`, "scout", item.name),
          },
        });
      }
    }

    for (const stage of [1, 2, 3, 4] as const) {
      await this.waitIfPaused(activity.id);
      if (this.cancelled.has(activity.id)) return;
      await delay(520);
      for (const item of activity.wishlist) {
        if (this.cancelled.has(activity.id)) return;
        await this.post(activity.id, {
          type: "item.progress",
          progress: {
            itemId: item.id,
            stage,
            previousStage: stage === 1 ? 0 : stage - 1,
            queued: false,
          },
        });
        for (const slot of [0, 1] as const) {
          const actions = [
            "",
            "opening listings",
            "checking seller and price",
            "comparing candidates",
            "shortlisting best fit",
          ];
          await this.post(activity.id, {
            type: "agent.update",
            agent: {
              agentId: `local-scout-${item.id}-${slot}`,
              itemId: item.id,
              slot,
              url: slot === 0 ? "local.market/listing" : "local.specialist/listing",
              stage,
              action: actions[stage],
              queued: false,
              liveStreamUrl: this.streamUrl(`scout-${item.id}-${slot}`, "scout", item.name),
            },
          });
        }
      }
    }
    await delay(450);
    if (this.cancelled.has(activity.id)) return;
    await this.post(activity.id, { type: "shortlist.ready", shortlist: localShortlist(activity) });
  }

  private async after(ms: number, activityId: string, body: unknown): Promise<void> {
    await delay(ms);
    if (this.cancelled.has(activityId)) return;
    await this.post(activityId, body);
  }

  private async waitIfPaused(activityId: string): Promise<void> {
    while (this.paused.has(activityId)) await delay(250);
  }

  private streamUrl(id: string, kind: string, label: string): string {
    const base = this.options.callbackBaseUrl.replace(/\/$/, "");
    return `${base}/v1/dev/streams/${encodeURIComponent(id)}?kind=${encodeURIComponent(kind)}&label=${encodeURIComponent(label)}`;
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
    if (!response.ok) throw new Error(`Local agent callback failed: ${response.status}`);
  }
}

export interface RemoteAgentOptions {
  baseUrl: string;
  token?: string;
  callbackBaseUrl: string;
  callbackToken?: string;
}

/**
 * Outbound protocol for the separately-owned agent runtime. The runtime posts
 * all durable results and live movement back to the authenticated callback URL.
 */
export class RemoteAgentProvider implements AgentProvider {
  readonly mode = "remote" as const;

  constructor(private readonly options: RemoteAgentOptions) {}

  async startPlanning(activity: Activity): Promise<void> {
    await this.post("/v1/runs/plan", {
      activityId: activity.id,
      goal: activity.messages.find((message) => message.role === "user")?.text ?? activity.title,
      callback: this.callback(activity.id),
      limits: { maxItems: 10 },
    });
  }

  async dispatchSearch(activity: Activity): Promise<void> {
    await this.post("/v1/runs/search", {
      activityId: activity.id,
      items: activity.wishlist,
      clarifications: activity.clarifications,
      callback: this.callback(activity.id),
      scouts: {
        perItem: 2,
        maxConcurrentItems: 5,
        listingsPerScout: 3,
        strategies: ["large-marketplaces", "specialist-independent"],
      },
    });
  }

  async setSearchPaused(activity: Activity, paused: boolean): Promise<void> {
    await this.post(`/v1/runs/${encodeURIComponent(activity.id)}/${paused ? "pause" : "resume"}`, {
      callback: this.callback(activity.id),
    });
  }

  async rejectListing(activity: Activity, itemId: string): Promise<void> {
    await this.post(`/v1/runs/${encodeURIComponent(activity.id)}/reject`, {
      itemId,
      feedback: "User rejected the selected listing; return the next best compliant candidate.",
      callback: this.callback(activity.id),
    });
  }

  async cancelPlanning(activity: Activity): Promise<void> {
    await this.cancelRun(activity);
  }

  async cancelSearch(activity: Activity): Promise<void> {
    await this.cancelRun(activity);
  }

  private async cancelRun(activity: Activity): Promise<void> {
    await this.post(`/v1/runs/${encodeURIComponent(activity.id)}/cancel`, {
      callback: this.callback(activity.id),
    });
  }

  private callback(activityId: string) {
    return {
      url: `${this.options.callbackBaseUrl.replace(/\/$/, "")}/v1/integrations/agents/${encodeURIComponent(activityId)}/events`,
      ...(this.options.callbackToken ? { token: this.options.callbackToken } : {}),
    };
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new HttpError(
        502,
        `Agent service rejected the request (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
  }
}

export class DisabledAgentProvider implements AgentProvider {
  readonly mode = "disabled" as const;

  private unavailable(): never {
    throw new HttpError(
      503,
      "Real agent service is not configured. Set AGENT_API_BASE_URL and its API credentials.",
    );
  }

  async startPlanning(): Promise<void> {
    this.unavailable();
  }

  async cancelPlanning(): Promise<void> {}

  async cancelSearch(): Promise<void> {}

  async dispatchSearch(): Promise<void> {
    this.unavailable();
  }

  async setSearchPaused(): Promise<void> {
    this.unavailable();
  }

  async rejectListing(): Promise<void> {
    this.unavailable();
  }
}

function localShortlist(activity: Activity) {
  // Stubbed discovery. The fixtures below point at example.com, which has no checkout — fine for
  // walking the UI, useless the moment a real Closer tries to buy from them. STUB_LISTINGS carries
  // URLs that resolve to something real, and DEMO_STORE_URL points at our own storefront, which is
  // the only target that completes a purchase offline.
  const stubbed = stubbedShortlist(activity);
  if (stubbed) return stubbed;

  return activity.wishlist.map((item) => {
    const isCable = item.id === "usb-c-cable" || /cable/i.test(item.name);
    return {
      itemId: item.id,
      reSearched: false,
      listing: isCable
        ? {
            title: "100W Braided USB-C Cable · 2m",
            seller: "Local Tech Demo",
            rating: "4.8 · 1,240 reviews",
            price: "S$18.90",
            amountMinor: 1890,
            why: "Meets the 100W and 2m requirements within budget.",
            url: "https://example.com/products/usb-c-cable",
          }
        : {
            title: "Foldable Aluminium Phone Stand",
            seller: "Desk Goods Demo",
            rating: "4.7 · 830 reviews",
            price: "S$24.90",
            amountMinor: 2490,
            why: "Adjustable, foldable, and suitable for desk use.",
            url: "https://example.com/products/phone-stand",
          },
      alternates: [
        isCable
          ? {
              title: "100W USB-C Cable · 1.8m",
              seller: "Cable House Demo",
              rating: "4.6 · 510 reviews",
              price: "S$16.50",
              amountMinor: 1650,
              why: "Compliant lower-cost fallback.",
              url: "https://example.com/products/usb-c-cable-alt",
            }
          : {
              title: "Compact Adjustable Phone Stand",
              seller: "Home Office Demo",
              rating: "4.6 · 405 reviews",
              price: "S$21.00",
              amountMinor: 2100,
              why: "Compliant lower-cost fallback.",
              url: "https://example.com/products/phone-stand-alt",
            },
      ],
    };
  });
}

/**
 * Listings the Closer can actually open, chosen by `SCOUT_LISTINGS`.
 *
 *   demo-store — our own storefront. The only target that completes a purchase offline, because
 *                AgentCore's browser runs in AWS and cannot reach localhost, so this pairs with
 *                CLOSER_BROWSER=local.
 *   stub       — the real Shopee and Lazada listings in stubListings.ts. Lazada throws a slider
 *                captcha a human clears in the live view; Shopee hard-bounces. Both are the
 *                measured truth rather than a happy path.
 *
 * Unset falls through to the example.com fixtures, which are fine for walking the UI and useless
 * for buying anything.
 */
function stubbedShortlist(activity: Activity) {
  const mode = process.env.SCOUT_LISTINGS;
  if (mode !== "demo-store" && mode !== "stub") return null;

  const pool =
    mode === "demo-store"
      ? demoStoreListings()
      : STUB_LISTINGS.map((l) => ({ ...l, rating: `${l.rating} · demo` }));

  return activity.wishlist.map((item, i) => {
    const listing = pool[i % pool.length];
    if (!listing) throw new Error("no stub listings configured");
    return { itemId: item.id, reSearched: false, listing, alternates: [] };
  });
}

function demoStoreListings() {
  const base = (process.env.DEMO_STORE_URL ?? "http://127.0.0.1:4030").replace(/\/$/, "");
  // Prices mirror apps/demo-store's own catalogue. They must match, or the Closer's total check
  // refuses the purchase — which is the check doing its job.
  return [
    {
      title: "Anker USB-C Hub",
      seller: "demo-store",
      rating: "4.7 · demo",
      price: "S$18.00",
      amountMinor: 1800,
      why: "Matches the specification within budget.",
      url: `${base}/item/usb-c-hub`,
    },
    {
      title: "1TB NVMe SSD",
      seller: "demo-store",
      rating: "4.8 · demo",
      price: "S$29.00",
      amountMinor: 2900,
      why: "Highest capacity still inside the card's S$30 ceiling.",
      url: `${base}/item/nvme-ssd`,
    },
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
