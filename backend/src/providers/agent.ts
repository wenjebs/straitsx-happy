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
 * It used to answer every request with the same two hardcoded items, which meant asking for
 * skincare and watching the scouts go looking for coffee. A stub that ignores the request is worse
 * than no stub: it looks like the search is broken when it is the planner that never read the
 * goal.
 *
 * So it splits what was actually typed. No model, no inference — it takes the request apart on
 * commas and "and", which is honest about being a fallback and still sends the scouts after the
 * thing that was asked for. Set PLANNER_MODE=openai for a planner that decomposes a real request
 * into a bill of materials.
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
    const goal =
      activity.messages.find((message) => message.role === "user")?.text?.trim() ||
      activity.title.trim();
    const names = splitGoal(goal);

    void this.after(700, activity.id, {
      type: "wishlist.ready",
      title: goal.length > 60 ? `${goal.slice(0, 57)}…` : goal,
      reply: `Working without a planner model, so I split your request literally into ${
        names.length === 1 ? "one item" : `${names.length} items`
      } and sent the scouts to the verified shops. Edit the list before dispatching if I read it wrong.`,
      wishlistEstimate: `up to S$${((names.length * 3000) / 100).toFixed(2)}`,
      wishlist: names.map((name, index) => ({
        id: `item-${index + 1}-${slug(name)}`,
        name,
        short: name.toUpperCase().slice(0, 16),
        // No model means no specification worth inventing. Saying so beats fabricating
        // "single origin · 250g · whole bean" for something the shopper never described.
        spec: "as described",
        // The card cannot mint above S$30, so nothing larger is worth searching for.
        budget: "up to S$30",
        hueIndex: index % 6,
      })),
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

/**
 * A typed request, cut into wishlist items.
 *
 * Splits on the separators people actually use for lists — commas, "and", newlines, bullets — and
 * strips the verbs a request opens with ("buy me a…", "find…") so the item reads as a thing rather
 * than an instruction. Anything it cannot split stays one item, which is the right answer for
 * "skincare".
 */
function splitGoal(goal: string): string[] {
  const parts = goal
    .split(/\n+|,|;|\band\b|\bplus\b|&/i)
    .map((part) =>
      part
        .replace(/^[\s\-*•\d.)]+/, "")
        .replace(/^(?:can you\s+|please\s+|i(?:'d| would) like\s+|i want\s+|i need\s+)/i, "")
        .replace(/^(?:buy|get|find|order|purchase|search for|look for|source)\s+/i, "")
        .replace(/^(?:me\s+)?(?:a|an|some|the)\s+/i, "")
        .trim(),
    )
    .filter((part) => part.length > 1);

  const unique: string[] = [];
  for (const part of parts) {
    if (!unique.some((existing) => existing.toLowerCase() === part.toLowerCase())) {
      unique.push(part);
    }
  }
  // Fall back to the raw goal rather than an empty wishlist, which the UI cannot dispatch.
  if (unique.length === 0) return [goal.slice(0, 80) || "something nice"];
  return unique.slice(0, 6);
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "item"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
