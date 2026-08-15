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
  confirmingWishlistRevert: false,
  wishlistReverting: false,
  confirmingActivityCancel: false,
  activityCancelling: false,
  confirmingPurchase: false,
  purchaseSubmitting: false,
  elapsed: 0,
  activities: [],
  running: null,
  viewingArchive: null,
  activityHistory: null,
  historyLoading: false,
  wallet: null,
  mandate: null,
  settings: null,
  profile: null,
  connection: Api.isLive() ? "connecting" : "error",
  error: null,
  loading: true,
};

type Action =
  | { type: "set"; patch: Partial<HappyState> }
  | { type: "event"; activityId: string; event: ActivityEvent };

function upsertActivity(activities: Activity[], activity: Activity): Activity[] {
  const next = activities.some((row) => row.id === activity.id)
    ? activities.map((row) => (row.id === activity.id ? activity : row))
    : [activity, ...activities];
  return next.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

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
  const current = state.activities.find((activity) => activity.id === action.activityId) ?? null;
  const activity = applyEvent(current, action.event);
  if (!activity) return state;
  const selected = state.focused === action.activityId;
  const archived = activity.status !== "live";
  return {
    ...state,
    activities: upsertActivity(state.activities, activity),
    running: state.running?.id === action.activityId ? (archived ? null : activity) : state.running,
    viewingArchive:
      selected && archived
        ? activity
        : state.viewingArchive?.id === action.activityId
          ? activity
          : state.viewingArchive,
  };
}

export interface HappyActions {
  send: () => Promise<void>;
  setDraft: (value: string) => void;
  setNewItem: (value: string) => void;
  toggleEditing: () => void;
  requestWishlistEdit: () => void;
  cancelWishlistEdit: () => void;
  confirmWishlistEdit: () => Promise<void>;
  requestActivityCancel: () => void;
  dismissActivityCancel: () => void;
  confirmActivityCancel: () => Promise<void>;
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
  setWallet: (wallet: Api.Wallet) => void;
  setMandate: (changes: Partial<Api.Mandate>) => Promise<void>;
  setSettings: (changes: Partial<Api.Settings>) => Promise<void>;
  goScreen: (screen: Screen) => void;
  back: () => void;
  openActivity: (id: string) => Promise<void>;
  viewActivityHistory: () => Promise<void>;
  closeActivityHistory: () => void;
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
          activities,
          running,
          focused: running?.id ?? null,
          wallet,
          mandate,
          settings,
          profile,
          loading: false,
          connection: Api.isLive() ? "open" : "error",
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

  /* Keep every live activity fresh while the user starts or views another one. */
  const liveActivityIds = state.activities
    .filter((activity) => activity.status === "live")
    .map((activity) => activity.id)
    .join("\u0000");
  useEffect(() => {
    const ids = liveActivityIds ? liveActivityIds.split("\u0000") : [];
    const subscriptions = ids.map((activityId) =>
      Api.subscribeToActivity(
        activityId,
        (event) => dispatch({ type: "event", activityId, event }),
        stateRef.current.running?.id === activityId
          ? (connection: ConnectionState) => set({ connection })
          : undefined,
      ),
    );
    return () =>
      subscriptions.forEach((subscription) => {
        subscription.close();
      });
  }, [liveActivityIds, set]);

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
    /** Updates the selected activity while retaining every other live activity. */
    const applied = (activity: Activity) => {
      const archived = activity.status !== "live";
      set({
        activities: upsertActivity(stateRef.current.activities, activity),
        running: archived ? null : activity,
        viewingArchive: archived ? activity : null,
        activityHistory: null,
        focused: activity.id,
        error: null,
      });
    };

    const showNewActivity = () => {
      set({
        screen: "purchase",
        focused: null,
        viewingArchive: null,
        activityHistory: null,
        historyLoading: false,
        draft: "",
        editing: false,
        confirmingWishlistRevert: false,
        wishlistReverting: false,
        confirmingActivityCancel: false,
        activityCancelling: false,
      });
      void Api.listActivities()
        .then((activities) =>
          set({
            activities: activities.reduce(
              (current, activity) => upsertActivity(current, activity),
              stateRef.current.activities,
            ),
          }),
        )
        .catch(fail);
    };

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
      requestWishlistEdit: () => {
        if (stateRef.current.running?.stage === "curate") {
          set({ confirmingWishlistRevert: true });
        }
      },
      cancelWishlistEdit: () => set({ confirmingWishlistRevert: false }),
      confirmWishlistEdit: async () => {
        const { running, wishlistReverting } = stateRef.current;
        if (!running || wishlistReverting) return;
        set({ wishlistReverting: true });
        try {
          applied(await Api.reopenWishlist(running.id));
          set({
            editing: true,
            confirmingWishlistRevert: false,
            wishlistReverting: false,
          });
        } catch (error) {
          set({ wishlistReverting: false });
          fail(error);
        }
      },
      requestActivityCancel: () => {
        if (stateRef.current.running?.status === "live") {
          set({ confirmingActivityCancel: true });
        }
      },
      dismissActivityCancel: () => set({ confirmingActivityCancel: false }),
      confirmActivityCancel: async () => {
        const { running, activityCancelling } = stateRef.current;
        if (!running || activityCancelling) return;
        set({ activityCancelling: true });
        try {
          applied(await Api.cancelActivity(running.id));
          set({ confirmingActivityCancel: false, activityCancelling: false });
        } catch (error) {
          set({ activityCancelling: false });
          fail(error);
        }
      },
      toggleSidebar: () => set({ sidebarOpen: !stateRef.current.sidebarOpen }),
      dismissError: () => set({ error: null }),

      send: () =>
        guard(async () => {
          const goal = stateRef.current.draft.trim() || "build me a budget gaming PC under S$1,600";
          set({ draft: "" });
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
          if (running) {
            applied(await Api.approveWishlist(running.id));
            set({ editing: false });
          }
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

      setWallet: (wallet) => set({ wallet, error: null }),

      setMandate: (changes) =>
        guard(async () => set({ mandate: await Api.updateMandate(changes), error: null })),

      setSettings: (changes) =>
        guard(async () => set({ settings: await Api.updateSettings(changes), error: null })),

      goScreen: (screen) => set({ screen }),

      back: showNewActivity,

      openActivity: (id) =>
        guard(async () => {
          const activity = await Api.getActivity(id);
          set({
            screen: "purchase",
            focused: activity.id,
            confirmingWishlistRevert: false,
            wishlistReverting: false,
            confirmingActivityCancel: false,
            activityCancelling: false,
            activityHistory: null,
            historyLoading: false,
            activities: upsertActivity(stateRef.current.activities, activity),
            ...(activity.status === "live"
              ? { running: activity, viewingArchive: null }
              : { viewingArchive: activity }),
          });
        }),

      viewActivityHistory: async () => {
        const archive = stateRef.current.viewingArchive;
        if (!archive || stateRef.current.historyLoading) return;
        set({ historyLoading: true });
        try {
          set({ activityHistory: await Api.getActivityHistory(archive.id), historyLoading: false });
        } catch (error) {
          set({ historyLoading: false });
          fail(error);
        }
      },
      closeActivityHistory: () => set({ activityHistory: null }),

      newActivity: showNewActivity,

      /*
       * Demo affordance from the stage bar. In live mode this asks the backend
       * to move the activity, so it stays honest rather than faking client state.
       */
      jumpToStage: (stage) =>
        guard(async () => {
          const { running } = stateRef.current;
          if (!running || stateRef.current.focused !== running.id) return;
          if (stage === "search") applied(await Api.dispatchAgents(running.id));
          else if (stage === "shortlist" || stage === "exec") {
            /* Never auto-start a spend from a nav control. */
            set({ error: null });
          }
        }),
    };
  }, [set, fail]);

  const displayed =
    state.focused === null
      ? null
      : (state.viewingArchive ?? (state.running?.id === state.focused ? state.running : null));

  return { state, actions, displayed };
}

export type { Focused };
