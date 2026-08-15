import type {
  Activity,
  AgentState,
  Clarification,
  ItemProgress,
  Message,
  WishlistItem,
} from "../domain.js";
import { DEFAULT_USER_ID, formatMinor, newId } from "../domain.js";
import { HttpError } from "../errors.js";
import type { EventHub } from "../events.js";
import type { PlannerProvider, ScoutProvider } from "../providers/agent.js";
import type { Repository } from "../repository.js";
import type { AgentCallback } from "../schemas.js";

export class ActivityService {
  constructor(
    private readonly repository: Repository,
    private readonly events: EventHub,
    private readonly planner: PlannerProvider,
    private readonly scouts: ScoutProvider,
  ) {}

  list(userId = DEFAULT_USER_ID): Promise<Activity[]> {
    return this.repository.listActivities(userId);
  }

  async get(id: string): Promise<Activity> {
    const activity = await this.repository.getActivity(id);
    if (!activity) throw new HttpError(404, `Activity ${id} was not found.`);
    return activity;
  }

  async history(id: string) {
    await this.get(id);
    return this.repository.listActivityCheckpoints(id);
  }

  async create(goal: string, userId = DEFAULT_USER_ID): Promise<Activity> {
    const existing = (await this.repository.listActivities(userId)).find(
      (activity) => activity.status === "live",
    );
    if (existing) {
      throw new HttpError(
        409,
        `Activity “${existing.title}” is still live. Complete or cancel it before starting another.`,
      );
    }

    const activity: Activity = {
      id: newId("act"),
      userId,
      title: goal.length > 72 ? `${goal.slice(0, 69)}…` : goal,
      stage: "wishlist",
      status: "live",
      createdAt: new Date().toISOString(),
      displayTs: "now",
      messages: [
        { id: newId("msg"), role: "user", text: goal },
        {
          id: newId("msg"),
          role: "assistant",
          text: "",
          card: "thinking",
          thinkingLabel: "decomposing goal into a wishlist",
        },
      ],
      wishlist: [],
      wishlistEstimate: "estimating…",
      clarifications: [],
      itemProgress: [],
      agents: [],
      searchPlaying: false,
      shortlist: [],
      execution: [],
      log: [],
      totalMinor: 0,
    };

    await this.repository.putActivity(activity, "activity.created");
    try {
      await this.planner.startPlanning(activity);
    } catch (error) {
      activity.status = "cancelled";
      activity.messages.push({
        id: newId("msg"),
        role: "assistant",
        text: error instanceof Error ? error.message : "The agent service could not start.",
      });
      await this.repository.putActivity(activity, "planning.failed");
      this.snapshot(activity);
      throw error;
    }
    return activity;
  }

  async addWishlistItem(id: string, name: string): Promise<Activity> {
    const activity = await this.requireStage(id, "wishlist");
    const hueIndex = this.nextHue(activity.wishlist);
    const item: WishlistItem = {
      id: newId("item"),
      name,
      short: this.shortName(name),
      spec: "Needs curation",
      budget: "pending",
      hueIndex,
      category: "General",
    };
    activity.wishlist.push(item);
    await this.saveSnapshot(activity, "wishlist.item_added");
    return activity;
  }

  async removeWishlistItem(id: string, itemId: string): Promise<Activity> {
    const activity = await this.requireStage(id, "wishlist");
    if (!activity.wishlist.some((item) => item.id === itemId)) {
      throw new HttpError(404, `Wishlist item ${itemId} was not found.`);
    }
    activity.wishlist = activity.wishlist.filter((item) => item.id !== itemId);
    activity.clarifications = activity.clarifications.filter((row) => row.itemId !== itemId);
    await this.saveSnapshot(activity, "wishlist.item_removed");
    return activity;
  }

  async approveWishlist(id: string): Promise<Activity> {
    const activity = await this.requireStage(id, "wishlist");
    if (activity.wishlist.length === 0) {
      throw new HttpError(409, "The agent has not returned a wishlist yet.");
    }
    activity.stage = "curate";
    activity.messages.push({ id: newId("msg"), role: "user", text: "Looks right — go ahead." });
    const next = activity.clarifications.find((row) => !row.chosen);
    activity.messages.push(next ? this.curatorMessage(activity, next) : this.lockedMessage());
    await this.saveSnapshot(activity, "wishlist.approved");
    return activity;
  }

  async chooseOption(id: string, itemId: string, optionName: string): Promise<Activity> {
    const activity = await this.requireStage(id, "curate");
    const clarification = activity.clarifications.find((row) => row.itemId === itemId);
    if (!clarification) throw new HttpError(404, `No clarification exists for item ${itemId}.`);
    if (!clarification.options.some((option) => option.name === optionName)) {
      throw new HttpError(422, `“${optionName}” is not one of the available options.`);
    }
    clarification.chosen = optionName;
    activity.messages.push({ id: newId("msg"), role: "user", text: optionName });
    const next = activity.clarifications.find((row) => !row.chosen);
    activity.messages.push(next ? this.curatorMessage(activity, next) : this.lockedMessage());
    await this.saveSnapshot(activity, "clarification.approved");
    return activity;
  }

  async dispatch(id: string): Promise<Activity> {
    const activity = await this.requireStage(id, "curate");
    const unresolved = activity.clarifications.find((row) => !row.chosen);
    if (unresolved)
      throw new HttpError(409, "Resolve every clarification before dispatching agents.");

    activity.stage = "search";
    activity.searchPlaying = true;
    activity.searchStartedAt = new Date().toISOString();
    activity.itemProgress = activity.wishlist.map((item, index) => ({
      itemId: item.id,
      stage: 0,
      previousStage: 0,
      queued: index >= 5,
    }));
    activity.agents = activity.wishlist.flatMap((item, index) =>
      ([0, 1] as const).map(
        (slot): AgentState => ({
          agentId: `pending-${item.id}-${slot}`,
          itemId: item.id,
          slot,
          url: "waiting for agent",
          stage: 0,
          action: index >= 5 ? "waiting for a slot" : "starting browser session",
          queued: index >= 5,
        }),
      ),
    );
    await this.repository.putActivity(activity, "search.dispatched");
    this.snapshot(activity);

    try {
      await this.scouts.dispatchSearch(activity);
    } catch (error) {
      activity.stage = "curate";
      activity.searchPlaying = false;
      activity.messages.push({
        id: newId("msg"),
        role: "assistant",
        text: error instanceof Error ? error.message : "The search agents could not start.",
      });
      await this.saveSnapshot(activity, "search.dispatch_failed");
      throw error;
    }
    return activity;
  }

  async setSearchPaused(id: string, paused: boolean): Promise<Activity> {
    const activity = await this.requireStage(id, "search");
    await this.scouts.setSearchPaused(activity, paused);
    activity.searchPlaying = !paused;
    await this.saveSnapshot(activity, paused ? "search.paused" : "search.resumed");
    return activity;
  }

  async rejectListing(id: string, itemId: string): Promise<Activity> {
    const activity = await this.requireStage(id, "shortlist");
    if (!activity.shortlist.some((pick) => pick.itemId === itemId)) {
      throw new HttpError(404, `No shortlist pick exists for item ${itemId}.`);
    }
    await this.scouts.rejectListing(activity, itemId);
    activity.stage = "search";
    activity.searchPlaying = true;
    activity.shortlist = activity.shortlist.filter((pick) => pick.itemId !== itemId);
    const existing = activity.itemProgress.find((row) => row.itemId === itemId);
    const progress: ItemProgress = {
      itemId,
      stage: 0,
      previousStage: existing?.stage ?? 4,
      queued: false,
    };
    activity.itemProgress = this.upsert(activity.itemProgress, progress, (row) => row.itemId);
    await this.repository.putActivity(activity, "shortlist.rejected");
    this.events.emit(activity.id, { type: "item.progress", progress });
    this.snapshot(activity);
    return activity;
  }

  async applyAgentEvent(id: string, event: AgentCallback): Promise<Activity> {
    const activity = await this.get(id);
    if (activity.status !== "live") {
      throw new HttpError(409, `Activity ${id} is not live.`);
    }

    switch (event.type) {
      case "wishlist.ready": {
        const ids = new Set(event.wishlist.map((item) => item.id));
        if (ids.size !== event.wishlist.length) {
          throw new HttpError(422, "Agent wishlist contains duplicate item ids.");
        }
        if (event.clarifications.some((row) => !ids.has(row.itemId))) {
          throw new HttpError(422, "A clarification references an item outside the wishlist.");
        }
        activity.title = event.title;
        activity.wishlist = event.wishlist.map((item, index) => ({ ...item, hueIndex: index % 6 }));
        activity.wishlistEstimate = event.wishlistEstimate;
        activity.clarifications = event.clarifications;
        const userMessage = activity.messages.find((message) => message.role === "user");
        activity.messages = [
          ...(userMessage ? [userMessage] : []),
          { id: newId("msg"), role: "assistant", text: event.reply, card: "wishlist" },
        ];
        await this.saveSnapshot(activity, "wishlist.prepared");
        break;
      }
      case "item.progress": {
        this.assertSearchItem(activity, event.progress.itemId);
        const current = activity.itemProgress.find((row) => row.itemId === event.progress.itemId);
        const progress: ItemProgress = {
          ...event.progress,
          previousStage: current?.stage ?? event.progress.previousStage,
        };
        if (current?.stage === progress.stage && current.queued === progress.queued)
          return activity;
        activity.itemProgress = this.upsert(activity.itemProgress, progress, (row) => row.itemId);
        await this.repository.putActivity(activity, "search.item_progress");
        this.events.emit(id, { type: "item.progress", progress });
        break;
      }
      case "agent.update": {
        this.assertSearchItem(activity, event.agent.itemId);
        const existingIndex = activity.agents.findIndex(
          (row) =>
            row.agentId === event.agent.agentId ||
            (row.itemId === event.agent.itemId && row.slot === event.agent.slot),
        );
        if (existingIndex >= 0) activity.agents[existingIndex] = event.agent;
        else activity.agents.push(event.agent);
        await this.repository.putActivity(activity, "search.agent_updated");
        this.events.emit(id, { type: "agent.update", agent: event.agent });
        break;
      }
      case "shortlist.ready": {
        const expected = new Set(activity.wishlist.map((item) => item.id));
        const received = new Set(event.shortlist.map((pick) => pick.itemId));
        if (
          expected.size !== received.size ||
          [...expected].some((itemId) => !received.has(itemId))
        ) {
          throw new HttpError(
            422,
            "Shortlist must contain exactly one pick for every wishlist item.",
          );
        }
        activity.shortlist = event.shortlist;
        activity.totalMinor = event.shortlist.reduce(
          (sum, pick) => sum + pick.listing.amountMinor,
          0,
        );
        activity.stage = "shortlist";
        activity.searchPlaying = false;
        await this.saveSnapshot(activity, "shortlist.prepared");
        break;
      }
      case "message.appended": {
        if (!activity.messages.some((message) => message.id === event.message.id)) {
          activity.messages.push(event.message);
          await this.repository.putActivity(activity, "chat.message_appended");
          this.events.emit(id, { type: "message.appended", message: event.message });
        }
        break;
      }
      case "run.failed": {
        activity.status = "cancelled";
        activity.searchPlaying = false;
        activity.messages.push({ id: newId("msg"), role: "assistant", text: event.message });
        await this.saveSnapshot(activity, "agent.failed");
        break;
      }
    }
    return activity;
  }

  private async requireStage(id: string, stage: Activity["stage"]): Promise<Activity> {
    const activity = await this.get(id);
    if (activity.stage !== stage || activity.status !== "live") {
      throw new HttpError(409, `Activity ${id} must be live and in ${stage} stage.`);
    }
    return activity;
  }

  private assertSearchItem(activity: Activity, itemId: string): void {
    if (activity.stage !== "search") throw new HttpError(409, "Activity is not searching.");
    if (!activity.wishlist.some((item) => item.id === itemId)) {
      throw new HttpError(422, `Agent event references unknown item ${itemId}.`);
    }
  }

  private curatorMessage(activity: Activity, clarification: Clarification): Message {
    const item = activity.wishlist.find((row) => row.id === clarification.itemId);
    return {
      id: newId("msg"),
      role: "assistant",
      text: clarification.prompt || `Choose the specification for ${item?.name ?? "this item"}.`,
      card: "curator",
      itemId: clarification.itemId,
    };
  }

  private lockedMessage(): Message {
    return {
      id: newId("msg"),
      role: "assistant",
      text: "Everything is spec-bound. The Scouts are ready to search real listings.",
      card: "locked",
    };
  }

  private nextHue(items: WishlistItem[]): number {
    for (let index = 0; index < 6; index += 1) {
      if (!items.some((item) => item.hueIndex === index)) return index;
    }
    return items.length % 6;
  }

  private shortName(name: string): string {
    const words = name.trim().split(/\s+/);
    if (words.length > 1)
      return words
        .map((word) => word[0])
        .join("")
        .slice(0, 6)
        .toUpperCase();
    return (
      name
        .replace(/[^a-z0-9]/gi, "")
        .slice(0, 6)
        .toUpperCase() || "ITEM"
    );
  }

  private upsert<T>(rows: T[], next: T, key: (row: T) => string): T[] {
    return rows.some((row) => key(row) === key(next))
      ? rows.map((row) => (key(row) === key(next) ? next : row))
      : [...rows, next];
  }

  private async saveSnapshot(activity: Activity, reason = "activity.updated"): Promise<void> {
    await this.repository.putActivity(activity, reason);
    this.snapshot(activity);
  }

  private snapshot(activity: Activity): void {
    this.events.emit(activity.id, {
      type: "activity.snapshot",
      activity: structuredClone(activity),
    });
  }
}

export function estimateWishlist(items: WishlistItem[]): string {
  const amounts = items
    .map((item) => Number(item.budget.replace(/[^\d.]/g, "")))
    .filter((amount) => Number.isFinite(amount));
  return amounts.length === items.length
    ? `est. ${formatMinor(Math.round(amounts.reduce((sum, amount) => sum + amount, 0) * 100))}`
    : "estimate pending";
}
