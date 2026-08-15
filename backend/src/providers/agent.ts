import type { Activity } from "../domain.js";
import { HttpError } from "../errors.js";

export interface PlannerProvider {
  readonly mode: "local" | "remote" | "openai" | "disabled";
  startPlanning(activity: Activity): Promise<void>;
  cancelPlanning?(activity: Activity): Promise<void>;
}

export interface ScoutProvider {
  readonly mode: "agentcore" | "remote" | "disabled";
  dispatchSearch(activity: Activity): Promise<void>;
  setSearchPaused(activity: Activity, paused: boolean): Promise<void>;
  rejectListing(activity: Activity, itemId: string): Promise<void>;
  cancelSearch?(activity: Activity): Promise<void>;
}

export interface AgentProvider extends PlannerProvider, ScoutProvider {
  readonly mode: "remote" | "disabled";
}

interface LocalPlannerOptions {
  callbackBaseUrl: string;
  callbackToken?: string;
}

/**
 * Local planner failsafe. It exercises the authenticated callback and the SSE path without an
 * OpenAI key, so the chat and wishlist screens work offline.
 *
 * It deliberately has no search half. The search phase used to be simulated here — four timed
 * stages and a hardcoded shortlist of products that did not exist — and that is now
 * `AgentCoreScoutProvider`, which drives real browsers over real storefronts.
 */
export class LocalPlannerProvider implements PlannerProvider {
  readonly mode = "local" as const;
  private readonly cancelled = new Set<string>();

  constructor(private readonly options: LocalPlannerOptions) {}

  async startPlanning(activity: Activity): Promise<void> {
    this.cancelled.delete(activity.id);
    void this.after(700, activity.id, {
      type: "wishlist.ready",
      title: "Coffee and a notebook",
      reply:
        "I turned that into two low-value items so you can safely walk through the complete agent and purchase flow.",
      wishlistEstimate: "est. S$40.00",
      // Chosen to match what the verified merchants in merchants.ts actually sell. A wishlist of
      // electronics would send real scouts to a coffee roaster and a bookshop and correctly find
      // nothing, which reads as a broken search rather than an empty one.
      wishlist: [
        {
          id: "filter-coffee",
          name: "Filter coffee beans",
          short: "COFFEE",
          spec: "single origin · 250g · whole bean",
          budget: "up to S$30",
          hueIndex: 0,
          category: "Groceries",
        },
        {
          id: "notebook",
          name: "Pocket notebook",
          short: "NOTEBOOK",
          spec: "A6 · plain or dotted · softcover",
          budget: "up to S$20",
          hueIndex: 1,
          category: "Stationery",
        },
      ],
      clarifications: [],
    });
  }

  async cancelPlanning(activity: Activity): Promise<void> {
    this.cancelled.add(activity.id);
  }

  private async after(ms: number, activityId: string, body: unknown): Promise<void> {
    await delay(ms);
    if (this.cancelled.has(activityId)) return;
    await this.post(activityId, body);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
