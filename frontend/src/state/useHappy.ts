import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { Activity, ActivityEvent, ActivityStage, ConnectionState } from "../lib/Api";
import * as Api from "../lib/Api";
import type { Focused, HappyState, Screen } from "./types";

const initialState: HappyState = {
  screen: "purchase",
  sidebarOpen: true,
  focused: null,
  draft: "",
  newItem: "",
  editing: false,
  detached: true,
  confirmingPurchase: false,
  purchaseSubmitting: false,
  elapsed: 0,
  running: null,
  archived: [],
  viewingArchive: null,
  wallet: null,
  mandate: null,
  settings: null,
  profile: null,
  connection: Api.isLive() ? "connecting" : "mock",
  error: null,
  loading: true,
};

type Action = { type: "set"; patch: Partial<HappyState> } | { type: "event"; event: ActivityEvent };

/**
 * Applies one server event. Each case touches only what moved, so a stage
 * change does not re-create the arrays the search screen is animating.
 */
function applyEvent(activity: Activity | null, event: ActivityEvent): Activity | null {
  if (event.type === "activity.snapshot") return event.activity;
  if (!activity) return activity;

  switch (event.type) {
    case "activity.stage":
      return { ...activity, stage: event.stage };

    case "item.progress": {
      const itemProgress = activity.itemProgress.some((p) => p.itemId === event.progress.itemId)
        ? activity.itemProgress.map((p) =>
            p.itemId === event.progress.itemId ? event.progress : p,
          )
        : [...activity.itemProgress, event.progress];
      return { ...activity, itemProgress };
    }

    case "agent.update": {
      const agents = activity.agents.some((a) => a.agentId === event.agent.agentId)
        ? activity.agents.map((a) => (a.agentId === event.agent.agentId ? event.agent : a))
        : [...activity.agents, event.agent];
      return { ...activity, agents };
    }

    case "exec.step": {
      const execution = activity.execution.some((r) => r.itemId === event.row.itemId)
        ? activity.execution.map((r) => (r.itemId === event.row.itemId ? event.row : r))
        : [...activity.execution, event.row];
      return { ...activity, execution };
    }

    case "log.line":
      return activity.log.some((l) => l.id === event.line.id)
        ? activity
        : { ...activity, log: [...activity.log, event.line] };

    case "message.appended":
      return activity.messages.some((m) => m.id === event.message.id)
        ? activity
        : { ...activity, messages: [...activity.messages, event.message] };

    case "shortlist.ready":
      return { ...activity, shortlist: event.shortlist, stage: "shortlist" };

    case "activity.completed":
      return {
        ...activity,
        status: "completed",
        completedAt: event.completedAt,
        displayTs: event.completedAt,
        totalMinor: event.totalMinor,
      };

    default:
      return activity;
  }
}

function reducer(state: HappyState, action: Action): HappyState {
  if (action.type === "set") return { ...state, ...action.patch };

  if (action.event.type === "wallet.updated") {
    return { ...state, wallet: action.event.wallet };
  }
  return { ...state, running: applyEvent(state.running, action.event) };
}

export interface HappyActions {
  send: () => Promise<void>;
  setDraft: (value: string) => void;
  setNewItem: (value: string) => void;
  toggleEditing: () => void;
  addItem: () => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  approveWishlist: () => Promise<void>;
  choose: (itemId: string, option: string) => Promise<void>;
  dispatchAgents: () => Promise<void>;
  togglePlay: () => Promise<void>;
  reject: (itemId: string) => Promise<void>;
  /** Opens the confirmation. Does not spend. */
  requestPurchase: () => void;
  cancelPurchase: () => void;
  /** The only call that spends. Never retried. */
  confirmPurchase: () => Promise<void>;
  topUp: () => Promise<void>;
  setMandate: (changes: Partial<Api.Mandate>) => Promise<void>;
  setSetting: (key: "notify" | "sandbox") => Promise<void>;
  goScreen: (screen: Screen) => void;
  back: () => void;
  openCurrent: () => void;
  openArchive: (id: string) => Promise<void>;
  newActivity: () => void;
  jumpToStage: (stage: ActivityStage) => Promise<void>;
  toggleSidebar: () => void;
  dismissError: () => void;
}

export interface Happy {
  state: HappyState;
  actions: HappyActions;
  /** The activity the main column should render, if any. */
  displayed: Activity | null;
}

export function useHappy(): Happy {
  const [state, dispatch] = useReducer(reducer, initialState);
  const set = useCallback((patch: Partial<HappyState>) => dispatch({ type: "set", patch }), []);
  const stateRef = useRef(state);
  stateRef.current = state;

  const fail = useCallback(
    (e: unknown) => set({ error: e instanceof Error ? e.message : String(e) }),
    [set],
  );

  /* Initial load. Every screen reads from the API in live mode. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [activities, wallet, mandate, settings, profile] = await Promise.all([
          Api.listActivities(),
          Api.getWallet(),
          Api.getMandate(),
          Api.getSettings(),
          Api.getProfile(),
        ]);
        if (cancelled) return;
        const running = activities.find((a) => a.status === "live") ?? null;
        set({
          archived: activities.filter((a) => a.status !== "live"),
          running,
          detached: !running,
          wallet,
          mandate,
          settings,
          profile,
          loading: false,
          connection: Api.isLive() ? "open" : "mock",
        });
      } catch (e) {
        if (!cancelled) {
          set({ loading: false, connection: "error" });
          fail(e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [set, fail]);

  /*
   * One subscription for the running activity. The stream is the source of
   * truth for anything that moves, so this stays open while the activity lives
   * — including while the user is on another screen, which is what lets the
   * feed card keep advancing.
   */
  const runningId = state.running?.id ?? null;
  useEffect(() => {
    if (!runningId) return;
    const sub = Api.subscribeToActivity(
      runningId,
      (event) => dispatch({ type: "event", event }),
      (connection: ConnectionState) => set({ connection }),
    );
    return () => sub.close();
  }, [runningId, set]);

  /* Elapsed counter for "t+42s". Ticks off the clock, not off agent events. */
  const startedAt = state.running?.searchStartedAt;
  const searching = state.running?.stage === "search" && state.running.searchPlaying;
  useEffect(() => {
    if (!startedAt || !searching) return;
    const base = new Date(startedAt).getTime();
    const update = () => set({ elapsed: Math.max(0, Math.round((Date.now() - base) / 1000)) });
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt, searching, set]);

  const actions = useMemo<HappyActions>(() => {
    /** Replaces the running activity with whatever a mutation returned. */
    const applied = (activity: Activity) => set({ running: activity, error: null });

    const guard = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        fail(e);
      }
    };

    return {
      setDraft: (value) => set({ draft: value }),
      setNewItem: (value) => set({ newItem: value }),
      toggleEditing: () => set({ editing: !stateRef.current.editing }),
      toggleSidebar: () => set({ sidebarOpen: !stateRef.current.sidebarOpen }),
      dismissError: () => set({ error: null }),

      send: () =>
        guard(async () => {
          const goal = stateRef.current.draft.trim() || "build me a budget gaming PC under S$1,600";
          set({ draft: "", detached: false });
          applied(await Api.createActivity(goal));
        }),

      addItem: () =>
        guard(async () => {
          const { running, newItem } = stateRef.current;
          if (!running || !newItem.trim()) return set({ newItem: "" });
          const next = await Api.addWishlistItem(running.id, newItem.trim());
          set({ newItem: "" });
          applied(next);
        }),

      removeItem: (itemId) =>
        guard(async () => {
          const { running } = stateRef.current;
          if (running) applied(await Api.removeWishlistItem(running.id, itemId));
        }),

      approveWishlist: () =>
        guard(async () => {
          const { running } = stateRef.current;
          if (running) applied(await Api.approveWishlist(running.id));
        }),

      choose: (itemId, option) =>
        guard(async () => {
          const { running } = stateRef.current;
          if (running) applied(await Api.chooseOption(running.id, itemId, option));
        }),

      dispatchAgents: () =>
        guard(async () => {
          const { running } = stateRef.current;
          if (running) applied(await Api.dispatchAgents(running.id));
        }),

      togglePlay: () =>
        guard(async () => {
          const { running } = stateRef.current;
          if (running) applied(await Api.setSearchPlaying(running.id, !running.searchPlaying));
        }),

      reject: (itemId) =>
        guard(async () => {
          const { running } = stateRef.current;
          if (running) applied(await Api.rejectPick(running.id, itemId));
        }),

      requestPurchase: () => set({ confirmingPurchase: true }),
      cancelPurchase: () => set({ confirmingPurchase: false }),

      /*
       * The one irreversible call. On the live rail this issues real single-use
       * cards, so it is guarded by an explicit confirmation, submitted once, and
       * never retried automatically — a retry here would double-spend.
       */
      confirmPurchase: async () => {
        const { running, purchaseSubmitting } = stateRef.current;
        if (!running || purchaseSubmitting) return;
        set({ purchaseSubmitting: true, confirmingPurchase: false });
        try {
          const key = `${running.id}:${running.totalMinor}:${Date.now()}`;
          applied(await Api.confirmPurchase(running.id, key));
        } catch (e) {
          fail(e);
        } finally {
          set({ purchaseSubmitting: false });
        }
      },

      topUp: () => guard(async () => set({ wallet: await Api.topUpWallet(50000), error: null })),

      setMandate: (changes) =>
        guard(async () => set({ mandate: await Api.updateMandate(changes), error: null })),

      setSetting: (key) =>
        guard(async () => {
          const current = stateRef.current.settings;
          if (!current) return;
          set({ settings: await Api.updateSettings({ [key]: !current[key] }), error: null });
        }),

      goScreen: (screen) => set({ screen }),

      back: () => set({ screen: "purchase", focused: null, detached: true, viewingArchive: null }),

      openCurrent: () =>
        set({ screen: "purchase", focused: "current", detached: false, viewingArchive: null }),

      openArchive: (id) =>
        guard(async () => {
          const activity = await Api.getActivity(id);
          set({ screen: "purchase", focused: id, viewingArchive: activity, detached: true });
        }),

      newActivity: () =>
        set({
          screen: "purchase",
          focused: null,
          detached: true,
          viewingArchive: null,
          running: null,
          draft: "",
          editing: false,
        }),

      /*
       * Demo affordance from the stage bar. In live mode this asks the backend
       * to move the activity, so it stays honest rather than faking client state.
       */
      jumpToStage: (stage) =>
        guard(async () => {
          const { running } = stateRef.current;
          set({ focused: "current", detached: false });
          if (!running) return;
          if (stage === "search") applied(await Api.dispatchAgents(running.id));
          else if (stage === "shortlist" || stage === "exec") {
            /* Never auto-start a spend from a nav control. */
            set({ error: null });
          }
        }),
    };
  }, [set, fail]);

  const displayed = state.viewingArchive ?? (state.detached ? null : state.running);

  return { state, actions, displayed };
}

export type { Focused };
