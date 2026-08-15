import { useEffect, useMemo, useReducer } from "react";
import { ACTIVITY_TITLE, type ArchiveId, ITEMS, type ItemId } from "../data/catalog";
import { activeItems, listingFor, logStamp, searchComplete } from "./derive";
import type { HappyState, Message, RuleState, Screen, Stage } from "./types";

/** Demo knobs. In production the tick is a server-pushed agent event. */
export interface HappyOptions {
  autoPlay?: boolean;
  /** 700–3500ms. */
  tickMs?: number;
}

const WISHLIST_REPLY =
  "Six parts get you a solid 1080p build. Prices are current Singapore street prices, " +
  "total lands near S$1,285 — inside your budget with room for a cooler if you want one.";

const DISPATCH_REPLY =
  "That is everything ambiguous resolved. The other four are spec-bound, so agents can " +
  "search them directly. Twelve agents, two per item, each working its own candidate listings.";

const RULE_CYCLE: readonly RuleState[] = ["allowed", "ask first", "blocked"];

export const initialState: HappyState = {
  screen: "purchase",
  stage: "idle",
  sidebarOpen: true,
  draft: "",
  msgs: [],
  editing: false,
  newItem: "",
  removed: {},
  chosen: {},
  rejected: {},
  tick: 0,
  playing: true,
  execStep: 0,
  log: [],
  balance: 4820.5,
  toast: "",
  autoApprove: true,
  itemCap: 600,
  actCap: 2500,
  ruleState: {
    Electronics: "allowed",
    Groceries: "allowed",
    Apparel: "ask first",
    Travel: "ask first",
    Collectibles: "blocked",
  },
  settingsState: { notify: true, sandbox: false },
  activityLive: false,
  activityDone: false,
  focused: null,
  actStage: "wishlist",
  actMsgs: [],
};

export type Action =
  | { type: "setDraft"; value: string }
  | { type: "setNewItem"; value: string }
  | { type: "send" }
  | { type: "wishlistReady" }
  | { type: "toggleEditing" }
  | { type: "addItem" }
  | { type: "removeItem"; id: ItemId }
  | { type: "approveWishlist" }
  | { type: "pick"; itemId: ItemId; option: string }
  | { type: "startSearch" }
  | { type: "tick" }
  | { type: "togglePlay" }
  | { type: "goStage"; stage: Stage }
  | { type: "goShortlist" }
  | { type: "reject"; id: ItemId }
  | { type: "confirmPurchase" }
  | { type: "execAdvance" }
  | { type: "topUp" }
  | { type: "toggleSidebar" }
  | { type: "goScreen"; screen: Screen }
  | { type: "back" }
  | { type: "openCurrent" }
  | { type: "openArchive"; id: ArchiveId }
  | { type: "newActivity" }
  | { type: "toggleAuto" }
  | { type: "setItemCap"; value: number }
  | { type: "setActCap"; value: number }
  | { type: "cycleRule"; name: string }
  | { type: "toggleSetting"; key: "notify" | "sandbox" };

function curatorMessage(itemId: ItemId, text: string): Message {
  return { kind: "curator", text, itemId };
}

function firstCuratorMessage(): Message {
  const gpu = ITEMS.find((i) => i.id === "gpu");
  return curatorMessage(
    "gpu",
    `Two calls need you before agents go out. First, ${(gpu?.name ?? "item").toLowerCase()} — ` +
      "three shapes this could take:",
  );
}

/**
 * Leaving a focused activity stashes its conversation so the in-flight run is
 * restored intact when its feed card is clicked again.
 */
function stash(s: HappyState): Pick<HappyState, "actStage" | "actMsgs" | "stage" | "msgs"> {
  return {
    actStage: s.stage !== "idle" ? s.stage : s.actStage,
    actMsgs: s.msgs.length ? s.msgs : s.actMsgs,
    stage: "idle",
    msgs: [],
  };
}

/** Seeded conversation for the stage bar's demo jumps. */
function seedMessages(stage: Stage): Message[] {
  const msgs: Message[] = [
    { kind: "user", text: "build me a budget gaming PC under S$1,600" },
    { kind: "wishlist", text: WISHLIST_REPLY },
  ];
  if (stage === "curate") {
    msgs.push({ kind: "user", text: "Looks right — go ahead." }, firstCuratorMessage());
  }
  return msgs;
}

export function reducer(s: HappyState, a: Action): HappyState {
  switch (a.type) {
    case "setDraft":
      return { ...s, draft: a.value };

    case "setNewItem":
      return { ...s, newItem: a.value };

    case "send": {
      const text = s.draft.trim() || "build me a budget gaming PC under S$1,600";
      return {
        ...s,
        draft: "",
        stage: "wishlist",
        activityLive: true,
        msgs: [
          { kind: "user", text },
          { kind: "thinking", text: "", label: "decomposing goal into a wishlist" },
        ],
      };
    }

    case "wishlistReady": {
      const first = s.msgs[0];
      if (!first) return s;
      return { ...s, msgs: [first, { kind: "wishlist", text: WISHLIST_REPLY }] };
    }

    case "toggleEditing":
      return { ...s, editing: !s.editing };

    case "addItem":
      return { ...s, newItem: "" };

    case "removeItem":
      return { ...s, removed: { ...s.removed, [a.id]: true } };

    case "approveWishlist":
      return {
        ...s,
        stage: "curate",
        editing: false,
        msgs: [...s.msgs, { kind: "user", text: "Looks right — go ahead." }, firstCuratorMessage()],
      };

    case "pick": {
      const chosen = { ...s.chosen, [a.itemId]: a.option };
      const msgs: Message[] = [...s.msgs, { kind: "user", text: a.option }];
      if (a.itemId === "gpu") {
        msgs.push(
          curatorMessage(
            "case",
            "Locked. Next, the case — this one changes thermals more than it looks:",
          ),
        );
      } else {
        msgs.push({ kind: "locked", text: DISPATCH_REPLY });
      }
      return { ...s, chosen, msgs };
    }

    case "startSearch":
      return { ...s, stage: "search", tick: 0, playing: true };

    case "tick":
      return { ...s, tick: s.tick + 1 };

    case "togglePlay":
      return { ...s, playing: !s.playing };

    case "goShortlist":
      return { ...s, stage: "shortlist" };

    case "goStage": {
      const base: HappyState = {
        ...s,
        screen: "purchase",
        stage: a.stage,
        activityLive: a.stage !== "idle",
      };
      if (a.stage === "search") return { ...base, tick: 0, playing: true };
      if (a.stage === "exec") {
        return { ...base, execStep: 0, log: [], activityDone: false, activityLive: true };
      }
      if (a.stage === "wishlist" || a.stage === "curate") {
        return { ...base, msgs: seedMessages(a.stage) };
      }
      return base;
    }

    case "reject":
      return { ...s, rejected: { ...s.rejected, [a.id]: true } };

    case "confirmPurchase":
      return {
        ...s,
        stage: "exec",
        execStep: 0,
        log: [],
        activityDone: false,
        activityLive: true,
      };

    case "execAdvance": {
      const items = activeItems(s);
      const n = s.execStep;
      const total = items.length * 4;
      if (n >= total) {
        const spent = items.reduce((sum, i) => sum + listingFor(s, i.id).amount, 0);
        return {
          ...s,
          activityDone: true,
          activityLive: false,
          balance: Math.round((s.balance - spent) * 100) / 100,
        };
      }
      const item = items[Math.floor(n / 4)];
      if (!item) return s;
      const listing = listingFor(s, item.id);
      const step = n % 4;
      const text =
        step === 0
          ? `card 4319 ${4400 + n} issued · limit ${listing.price}`
          : step === 1
            ? `${listing.seller.toLowerCase().replace(/ /g, "-")}/checkout · autofill ok`
            : step === 2
              ? `placing order ${listing.price}`
              : `order #SG${830142 + n * 7} confirmed · card expired`;
      return {
        ...s,
        execStep: n + 1,
        log: [...s.log, { ts: logStamp(n), short: item.short, hue: item.hue, text }],
      };
    }

    case "topUp":
      return {
        ...s,
        balance: Math.round((s.balance + 500) * 100) / 100,
        toast: "+500.00 XSGD received · tx 0x4c…9ae1 · 3 confirmations",
      };

    case "toggleSidebar":
      return { ...s, sidebarOpen: !s.sidebarOpen };

    case "goScreen":
      return { ...s, screen: a.screen, toast: "" };

    case "back":
      return { ...s, screen: "purchase", focused: null, toast: "", ...stash(s) };

    case "openCurrent":
      return {
        ...s,
        screen: "purchase",
        focused: "current",
        stage: s.stage !== "idle" ? s.stage : s.actStage,
        msgs: s.msgs.length ? s.msgs : s.actMsgs,
      };

    case "openArchive":
      return { ...s, screen: "purchase", focused: a.id, ...stash(s) };

    case "newActivity":
      return {
        ...s,
        screen: "purchase",
        stage: "idle",
        msgs: [],
        tick: 0,
        log: [],
        execStep: 0,
        rejected: {},
        chosen: {},
        removed: {},
        activityLive: false,
        activityDone: false,
        focused: null,
        actMsgs: [],
        actStage: "wishlist",
      };

    case "toggleAuto":
      return { ...s, autoApprove: !s.autoApprove };

    case "setItemCap":
      return { ...s, itemCap: a.value };

    case "setActCap":
      return { ...s, actCap: a.value };

    case "cycleRule": {
      const current = s.ruleState[a.name] ?? "allowed";
      const next = RULE_CYCLE[(RULE_CYCLE.indexOf(current) + 1) % RULE_CYCLE.length] ?? "allowed";
      return { ...s, ruleState: { ...s.ruleState, [a.name]: next } };
    }

    case "toggleSetting":
      return {
        ...s,
        settingsState: { ...s.settingsState, [a.key]: !s.settingsState[a.key] },
      };

    default:
      return s;
  }
}

export interface Happy {
  state: HappyState;
  dispatch: React.Dispatch<Action>;
  tickMs: number;
  title: string;
}

export function useHappy(options: HappyOptions = {}): Happy {
  const tickMs = options.tickMs ?? 1500;
  const autoPlay = options.autoPlay !== false;
  const [state, dispatch] = useReducer(reducer, initialState, (s) => ({
    ...s,
    playing: autoPlay,
  }));

  const thinking = state.msgs.some((m) => m.kind === "thinking");
  const complete = state.stage === "search" && searchComplete(state);

  /* The assistant's reply lands ~1100ms after the goal is sent. */
  useEffect(() => {
    if (!thinking) return;
    const id = setTimeout(() => dispatch({ type: "wishlistReady" }), 1100);
    return () => clearTimeout(id);
  }, [thinking]);

  /* Agents advance one stage per tick. Pause stops it without losing position. */
  useEffect(() => {
    if (state.stage !== "search" || !state.playing || complete) return;
    const id = setInterval(() => dispatch({ type: "tick" }), tickMs);
    return () => clearInterval(id);
  }, [state.stage, state.playing, complete, tickMs]);

  /* Once every item is Selected the screen hands over to the shortlist. */
  useEffect(() => {
    if (!complete) return;
    const id = setTimeout(() => dispatch({ type: "goShortlist" }), 1400);
    return () => clearTimeout(id);
  }, [complete]);

  /* Purchases run strictly sequentially, four steps per item. */
  useEffect(() => {
    if (state.stage !== "exec" || state.activityDone) return;
    const id = setInterval(() => dispatch({ type: "execAdvance" }), 620);
    return () => clearInterval(id);
  }, [state.stage, state.activityDone]);

  return useMemo(() => ({ state, dispatch, tickMs, title: ACTIVITY_TITLE }), [state, tickMs]);
}
