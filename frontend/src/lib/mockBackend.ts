/*
 * An in-browser stand-in for the backend, used whenever VITE_API_BASE_URL is
 * unset.
 *
 * It is written as a *server*, not as UI state: it owns the activity record,
 * advances it on timers, and pushes the same events over the same channel the
 * SSE endpoint will. Nothing in the UI knows which of the two it is talking to.
 *
 * That symmetry is the point. When the real backend arrives, the code paths the
 * UI exercises are the ones already running here.
 */

import {
  ACTIVITY_TITLE,
  AGENT_HOSTS,
  ALTERNATES,
  ARCHIVE,
  type ArchiveId,
  CURATOR,
  DISPOSABLE_CARDS,
  EXEC_STEPS,
  ITEMS,
  type ItemId,
  LISTINGS,
  PAST_ACTIVITIES,
  PROFILE_ROWS,
  STAGE_ACTIONS,
  STAGES,
  TRANSACTIONS,
} from "../data/catalog";
import type {
  Activity,
  ActivityCheckpoint,
  ActivityEvent,
  AgentState,
  Clarification,
  ItemProgress,
  LogLine,
  Mandate,
  Message,
  Profile,
  Settings,
  ShortlistPick,
  StageIndex,
  Subscription,
  Wallet,
  WishlistItem,
} from "./Api";

/** Milliseconds between agent moves. */
const TICK_MS = 1500;
/** Milliseconds between execution steps. */
const EXEC_STEP_MS = 620;
/** How long the assistant "thinks" before the wishlist lands. */
const THINKING_MS = 1100;
/** Pause after every item reaches Selected before handing over to the shortlist. */
const HANDOVER_MS = 1400;

const CURRENT_ID = "act-current";

const WISHLIST_REPLY =
  "Six parts get you a solid 1080p build. Prices are current Singapore street prices, " +
  "total lands near S$1,285 — inside your budget with room for a cooler if you want one.";

const DISPATCH_REPLY =
  "That is everything ambiguous resolved. The other four are spec-bound, so agents can " +
  "search them directly. Twelve agents, two per item, each working its own candidate listings.";

let messageSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++messageSeq}`;

function toWishlistItem(id: ItemId): WishlistItem | null {
  const index = ITEMS.findIndex((i) => i.id === id);
  const item = ITEMS[index];
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    short: item.short,
    spec: item.spec,
    budget: item.budget,
    hueIndex: index,
  };
}

function hueIndexOf(id: string): number {
  const index = ITEMS.findIndex((i) => i.id === id);
  return index < 0 ? 0 : index;
}

/** Agent log timestamps start at 14:32:08 and advance 3s per line. */
function logStamp(n: number): string {
  const base = 14 * 3600 + 32 * 60 + 8 + n * 3;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(Math.floor(base / 3600))}:${pad(Math.floor((base % 3600) / 60))}:${pad(base % 60)}`;
}

function archivedActivity(id: ArchiveId): Activity {
  const a = ARCHIVE[id];
  const meta = PAST_ACTIVITIES.find((p) => p.id === id);
  return {
    id,
    title: a.title,
    stage: "idle",
    status: a.state === "cancelled" ? "cancelled" : "completed",
    createdAt: new Date().toISOString(),
    displayTs: meta?.ts ?? a.ts,
    messages: [],
    wishlist: [],
    wishlistEstimate: "",
    clarifications: [],
    itemProgress: [],
    agents: [],
    searchPlaying: false,
    shortlist: [],
    execution: [],
    log: [],
    totalMinor: Math.round(Number(a.total.replace(/[^\d.]/g, "")) * 100),
    archiveLines: a.lines.map((l) => ({ ...l })),
    /* The archive view needs the timestamp the header shows, not the feed's. */
    completedAt: a.ts,
  };
}

class MockBackend {
  private current: Activity | null = null;
  private listeners = new Map<string, Set<(event: ActivityEvent) => void>>();
  private timers: ReturnType<typeof setInterval>[] = [];
  /** Search progress counter, equivalent to the server's agent clock. */
  private tick = 0;
  private execStep = 0;

  private wallet: Wallet = {
    balanceMinor: 482050,
    address: "0x8f…c14b",
    network: "Polygon",
    cards: DISPOSABLE_CARDS.map((c) => ({ ...c })),
    transactions: TRANSACTIONS.map((t, i) => ({ id: `txn-${i}`, ...t })),
  };

  private mandate: Mandate = {
    autoApprove: true,
    itemCap: 600,
    actCap: 2500,
  };

  private settings: Settings = {
    region: "Singapore · SGD",
    dataRetention: "90 days",
  };

  // -- transport ------------------------------------------------------------

  subscribe(id: string, onEvent: (event: ActivityEvent) => void): Subscription {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(onEvent);

    /* Mirror the SSE contract: a snapshot always arrives first. */
    const activity = id === CURRENT_ID ? this.current : archivedActivity(id as ArchiveId);
    if (activity) queueMicrotask(() => onEvent({ type: "activity.snapshot", activity }));

    return {
      close: () => {
        set.delete(onEvent);
        if (set.size === 0) this.listeners.delete(id);
      },
    };
  }

  private emit(event: ActivityEvent): void {
    const id = this.current?.id;
    if (!id) return;
    for (const listener of this.listeners.get(id) ?? []) listener(event);
  }

  private snapshot(): void {
    if (this.current) this.emit({ type: "activity.snapshot", activity: this.clone(this.current) });
  }

  private clone(a: Activity): Activity {
    return structuredClone(a);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // -- activities -----------------------------------------------------------

  async listActivities(): Promise<Activity[]> {
    const past = PAST_ACTIVITIES.map((p) => archivedActivity(p.id));
    return this.current ? [this.clone(this.current), ...past] : past;
  }

  async getActivity(id: string): Promise<Activity> {
    if (id === CURRENT_ID && this.current) return this.clone(this.current);
    const archived = archivedActivity(id as ArchiveId);
    if (!archived) throw new Error(`no such activity: ${id}`);
    return archived;
  }

  async getActivityHistory(id: string): Promise<ActivityCheckpoint[]> {
    const activity = await this.getActivity(id);
    return [
      {
        checkpointId: `mock-${id}`,
        activityId: id,
        userId: "mock-user",
        reason: activity.status === "completed" ? "purchase.completed" : "activity.cancelled",
        createdAt: activity.createdAt,
        stage: activity.stage,
        status: activity.status,
        activity,
      },
    ];
  }

  async cancelActivity(_id: string): Promise<Activity> {
    if (this.current?.status !== "live") throw new Error("no live activity");
    this.clearTimers();
    this.current.status = "cancelled";
    this.current.searchPlaying = false;
    this.current.completedAt = new Date().toISOString();
    this.current.displayTs = "now";
    this.current.messages.push({
      id: nextId("msg"),
      role: "assistant",
      text: "This activity was cancelled. Happy will ignore any later agent updates.",
    });
    this.snapshot();
    return this.clone(this.current);
  }

  async createActivity(goal: string): Promise<Activity> {
    this.clearTimers();
    this.tick = 0;
    this.execStep = 0;
    messageSeq = 0;

    const wishlist = ITEMS.map((i) => toWishlistItem(i.id)).filter((i): i is WishlistItem => !!i);
    this.current = {
      id: CURRENT_ID,
      title: ACTIVITY_TITLE,
      stage: "wishlist",
      status: "live",
      createdAt: new Date().toISOString(),
      displayTs: "now",
      messages: [
        { id: nextId("msg"), role: "user", text: goal },
        {
          id: nextId("msg"),
          role: "assistant",
          text: "",
          card: "thinking",
          thinkingLabel: "decomposing goal into a wishlist",
        },
      ],
      wishlist,
      wishlistEstimate: "est. S$1,285",
      clarifications: [],
      itemProgress: [],
      agents: [],
      searchPlaying: true,
      shortlist: [],
      execution: [],
      log: [],
      totalMinor: 0,
    };

    /* The reply lands a beat later, exactly as a real agent's would. */
    setTimeout(() => {
      if (!this.current) return;
      const first = this.current.messages[0];
      this.current.messages = [
        ...(first ? [first] : []),
        { id: nextId("msg"), role: "assistant", text: WISHLIST_REPLY, card: "wishlist" },
      ];
      this.snapshot();
    }, THINKING_MS);

    return this.clone(this.current);
  }

  async addWishlistItem(_id: string, _name: string): Promise<Activity> {
    /* The prototype accepts the input but does not add a row; kept faithful. */
    if (!this.current) throw new Error("no active activity");
    return this.clone(this.current);
  }

  async removeWishlistItem(_id: string, itemId: string): Promise<Activity> {
    if (!this.current) throw new Error("no active activity");
    this.current.wishlist = this.current.wishlist.filter((w) => w.id !== itemId);
    this.snapshot();
    return this.clone(this.current);
  }

  async approveWishlist(_id: string): Promise<Activity> {
    if (!this.current) throw new Error("no active activity");
    this.current.stage = "curate";
    this.current.messages.push(
      { id: nextId("msg"), role: "user", text: "Looks right — go ahead." },
      this.curatorMessage("gpu"),
    );
    this.current.clarifications = [this.clarificationFor("gpu")].filter(
      (c): c is Clarification => !!c,
    );
    this.snapshot();
    return this.clone(this.current);
  }

  async reopenWishlist(_id: string): Promise<Activity> {
    if (this.current?.stage !== "curate") {
      throw new Error("activity is not awaiting clarification");
    }
    const wishlistMessageIndex = this.current.messages.findIndex(
      (message) => message.role === "assistant" && message.card === "wishlist",
    );
    if (wishlistMessageIndex < 0) throw new Error("activity has no prepared wishlist");
    this.current.stage = "wishlist";
    this.current.messages = this.current.messages.slice(0, wishlistMessageIndex + 1);
    this.current.clarifications = this.current.clarifications.map((clarification) => {
      const reset = { ...clarification };
      delete reset.chosen;
      return reset;
    });
    this.snapshot();
    return this.clone(this.current);
  }

  private curatorMessage(itemId: ItemId): Message {
    const item = ITEMS.find((i) => i.id === itemId);
    const text =
      itemId === "gpu"
        ? `Two calls need you before agents go out. First, ${(item?.name ?? "item").toLowerCase()} — three shapes this could take:`
        : "Locked. Next, the case — this one changes thermals more than it looks:";
    return { id: nextId("msg"), role: "assistant", text, card: "curator", itemId };
  }

  private clarificationFor(itemId: ItemId): Clarification | null {
    const options = CURATOR[itemId];
    if (!options) return null;
    return { itemId, prompt: "", options: options.map((o) => ({ ...o })) };
  }

  async chooseOption(_id: string, itemId: string, option: string): Promise<Activity> {
    if (!this.current) throw new Error("no active activity");
    const existing = this.current.clarifications.find((c) => c.itemId === itemId);
    if (existing) existing.chosen = option;

    this.current.messages.push({ id: nextId("msg"), role: "user", text: option });
    if (itemId === "gpu") {
      this.current.messages.push(this.curatorMessage("case"));
      const next = this.clarificationFor("case");
      if (next) this.current.clarifications.push(next);
    } else {
      this.current.messages.push({
        id: nextId("msg"),
        role: "assistant",
        text: DISPATCH_REPLY,
        card: "locked",
      });
    }
    this.snapshot();
    return this.clone(this.current);
  }

  // -- search ---------------------------------------------------------------

  async dispatchAgents(_id: string): Promise<Activity> {
    if (!this.current) throw new Error("no active activity");
    this.clearTimers();
    this.tick = 0;
    this.current.stage = "search";
    this.current.searchPlaying = true;
    this.current.searchStartedAt = new Date().toISOString();
    this.current.itemProgress = this.current.wishlist.map((w) => this.progressFor(w.id, 0));
    this.current.agents = this.buildAgents();
    this.snapshot();
    this.runSearch();
    return this.clone(this.current);
  }

  /** Where an item sits at a given tick, following its authored path. */
  private progressFor(itemId: string, tick: number): ItemProgress {
    const item = ITEMS.find((i) => i.id === itemId);
    if (!item) return { itemId, stage: 0, previousStage: 0, queued: false };
    const last = item.path.length - 1;
    const c = Math.max(0, Math.min(last, tick - item.start));
    const stage = (item.path[c] ?? 0) as StageIndex;
    const previousStage = c > 0 ? ((item.path[c - 1] ?? stage) as StageIndex) : stage;
    return { itemId, stage, previousStage, queued: tick < item.start };
  }

  private buildAgents(): AgentState[] {
    const agents: AgentState[] = [];
    this.current?.wishlist.forEach((w, index) => {
      const progress = this.progressFor(w.id, this.tick);
      for (let slot = 0; slot < 2; slot++) {
        const stage = (slot === 0 ? progress.stage : Math.max(0, progress.stage - 1)) as StageIndex;
        agents.push({
          agentId: `ag-${(4100 + index * 17 + slot * 3).toString(16)}`,
          itemId: w.id,
          slot,
          url: `${AGENT_HOSTS[w.id as ItemId] ?? w.id}${slot ? "?p=2" : ""}`,
          stage,
          action: progress.queued ? "waiting for a slot" : (STAGE_ACTIONS[stage] ?? ""),
          queued: progress.queued,
        });
      }
    });
    return agents;
  }

  private searchComplete(): boolean {
    return (this.current?.wishlist ?? []).every((w) => {
      const item = ITEMS.find((i) => i.id === w.id);
      return item ? this.tick - item.start >= item.path.length - 1 : true;
    });
  }

  private runSearch(): void {
    const timer = setInterval(() => {
      if (this.current?.stage !== "search") return;
      if (this.searchComplete()) {
        this.clearTimers();
        setTimeout(() => {
          if (!this.current) return;
          this.current.stage = "shortlist";
          this.current.shortlist = this.buildShortlist();
          this.current.totalMinor = this.total();
          this.snapshot();
        }, HANDOVER_MS);
        return;
      }

      this.tick += 1;
      /*
       * One event per item that actually moved. The client animates each as it
       * lands, so these must not be collapsed into a single snapshot.
       */
      for (const w of this.current.wishlist) {
        const progress = this.progressFor(w.id, this.tick);
        const index = this.current.itemProgress.findIndex((p) => p.itemId === w.id);
        if (index >= 0) this.current.itemProgress[index] = progress;
        this.emit({ type: "item.progress", progress });
      }
      this.current.agents = this.buildAgents();
      for (const agent of this.current.agents) this.emit({ type: "agent.update", agent });
    }, TICK_MS);
    this.timers.push(timer);
  }

  async setSearchPlaying(_id: string, playing: boolean): Promise<Activity> {
    if (!this.current) throw new Error("no active activity");
    this.current.searchPlaying = playing;
    this.clearTimers();
    if (playing) this.runSearch();
    this.snapshot();
    return this.clone(this.current);
  }

  // -- shortlist ------------------------------------------------------------

  private buildShortlist(): ShortlistPick[] {
    const existing = new Map(this.current?.shortlist.map((p) => [p.itemId, p]));
    return (this.current?.wishlist ?? []).map((w) => {
      const prior = existing.get(w.id);
      if (prior) return prior;
      const listing = LISTINGS[w.id as ItemId];
      return {
        itemId: w.id,
        reSearched: false,
        listing: { ...listing, amountMinor: listing.amount * 100 },
      };
    });
  }

  private total(): number {
    return (this.current?.shortlist ?? []).reduce((sum, p) => sum + p.listing.amountMinor, 0);
  }

  async rejectPick(_id: string, itemId: string): Promise<Activity> {
    if (!this.current) throw new Error("no active activity");
    const pick = this.current.shortlist.find((p) => p.itemId === itemId);
    const alternate = ALTERNATES[itemId as ItemId];
    if (pick && alternate) {
      pick.listing = { ...alternate, amountMinor: alternate.amount * 100 };
      pick.reSearched = true;
    } else if (pick) {
      pick.reSearched = true;
    }
    this.current.totalMinor = this.total();
    this.snapshot();
    return this.clone(this.current);
  }

  // -- execution ------------------------------------------------------------

  async confirmPurchase(_id: string): Promise<Activity> {
    if (!this.current) throw new Error("no active activity");
    this.clearTimers();
    this.execStep = 0;
    this.current.stage = "exec";
    this.current.log = [];
    this.current.execution = this.current.shortlist.map((p) => ({
      itemId: p.itemId,
      step: 0,
      state: "queued" as const,
    }));
    this.snapshot();

    const timer = setInterval(() => this.advanceExecution(), EXEC_STEP_MS);
    this.timers.push(timer);
    return this.clone(this.current);
  }

  private advanceExecution(): void {
    if (!this.current) return;
    const picks = this.current.shortlist;
    const n = this.execStep;
    const total = picks.length * 4;

    if (n >= total) {
      this.clearTimers();
      this.wallet.balanceMinor -= this.total();
      this.current.status = "completed";
      this.current.completedAt = "14:41";
      this.current.displayTs = "14:41";
      this.current.totalMinor = this.total();
      this.emit({
        type: "activity.completed",
        completedAt: "14:41",
        totalMinor: this.current.totalMinor,
      });
      this.emit({ type: "wallet.updated", wallet: structuredClone(this.wallet) });
      this.snapshot();
      return;
    }

    const pick = picks[Math.floor(n / 4)];
    if (!pick) return;
    const step = n % 4;
    const row = {
      itemId: pick.itemId,
      step: step + 1,
      state: (step === 3 ? "purchased" : "live") as "live" | "purchased",
    };
    const index = this.current.execution.findIndex((r) => r.itemId === pick.itemId);
    if (index >= 0) this.current.execution[index] = row;

    const seller = pick.listing.seller.toLowerCase().replace(/ /g, "-");
    const text =
      step === 0
        ? `card 4319 ${4400 + n} issued · limit ${pick.listing.price}`
        : step === 1
          ? `${seller}/checkout · autofill ok`
          : step === 2
            ? `placing order ${pick.listing.price}`
            : `order #SG${830142 + n * 7} confirmed · card expired`;

    const line: LogLine = {
      id: nextId("log"),
      ts: logStamp(n),
      tag: this.current.wishlist.find((w) => w.id === pick.itemId)?.short ?? "SYS",
      hueIndex: hueIndexOf(pick.itemId),
      text,
    };
    this.current.log.push(line);

    this.execStep = n + 1;
    this.emit({ type: "exec.step", row });
    this.emit({ type: "log.line", line });
  }

  // -- wallet, mandate, settings, profile -----------------------------------

  async getWallet(): Promise<Wallet> {
    return structuredClone(this.wallet);
  }

  async topUpWallet(amountMinor: number): Promise<Wallet> {
    this.wallet.balanceMinor += amountMinor;
    this.wallet.receipt = "+500.00 XSGD received · tx 0x4c…9ae1 · 3 confirmations";
    return structuredClone(this.wallet);
  }

  async getMandate(): Promise<Mandate> {
    return structuredClone(this.mandate);
  }

  async updateMandate(changes: Partial<Mandate>): Promise<Mandate> {
    this.mandate = { ...this.mandate, ...changes };
    return structuredClone(this.mandate);
  }

  async getSettings(): Promise<Settings> {
    return structuredClone(this.settings);
  }

  async updateSettings(changes: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...changes };
    return structuredClone(this.settings);
  }

  async getProfile(): Promise<Profile> {
    return {
      name: "Tricia Lim",
      email: "tricia.lim@hey.sg",
      initials: "TL",
      memberSince: "tricia.lim@hey.sg · member since Mar 2026",
      rows: PROFILE_ROWS.map((r) => ({ ...r })),
    };
  }

  /** Resets to a clean slate, as the feed's "+" button does. */
  reset(): void {
    this.clearTimers();
    this.current = null;
    this.tick = 0;
    this.execStep = 0;
  }

  /** Stage labels are the client's, but the mock needs them for agent actions. */
  static stageLabel(stage: StageIndex): string {
    return STAGES[stage];
  }

  /** Exposed so the client can show the same step labels the server would send. */
  static stepLabel(step: number): string {
    return EXEC_STEPS[Math.max(0, Math.min(3, step - 1))] ?? "queued";
  }
}

export const mockBackend = new MockBackend();
