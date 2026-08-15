# Handoff: Happy — AI Shopping Concierge Prototype

## Overview
Happy is an AI shopping concierge: agents research, compare and purchase real products on a
user's behalf, paying with a disposable single-use virtual card (XSGD). The prototype covers the
full flow — goal in chat → wishlist approval → per-item clarification → parallel multi-agent
search → shortlist confirmation → sequential purchase execution → completed — plus Wallet,
Mandate, Settings and Profile screens.

The product thesis the UI serves: someone is about to watch AI agents spend real money for them,
so every stage of otherwise-invisible agent work must be observable. The multi-agent search
screen is the signature moment and deserves the most implementation care.

## About the Design Files
`Happy.dc.html` in this bundle is a **design reference created in HTML** — a clickable prototype
showing intended look and behavior. It is not production code to port line by line. The task is
to **recreate this design in the target codebase's existing environment** (React, Vue, SwiftUI,
native, etc.) using its established component library, routing, state and styling patterns. If no
environment exists yet, choose the framework appropriate to the project and implement there.

The prototype uses a small in-house streaming template runtime (`<sc-for>`, `<sc-if>`,
`{{ hole }}`, a `Component extends DCLogic` class with `renderVals()`). Treat that as an
implementation detail of the prototype: `renderVals()` is the equivalent of a render function's
derived values, `state` maps to component state, and `sc-for`/`sc-if` map to `.map()` and
conditional rendering. All styling is inline style objects — in a real codebase, move these to
whatever styling system exists (CSS modules, Tailwind, styled-components, tokens).

Everything is mock: `setInterval` timers drive state, and all data is hardcoded dummy content.
Real implementation replaces those timers with server events (WebSocket / SSE / polling) and the
hardcoded arrays with API responses. The visual and motion spec below is what must survive.

## Fidelity
**High-fidelity.** Colors, typography, spacing, motion durations and easings are final and
specified exactly below. Recreate pixel-accurately using the codebase's primitives. Copy text is
final — use it verbatim where the same content applies.

## Design Tokens

### Color — grayscale shell
The shell is strictly black / white / gray. Color appears in exactly two places: per-item
identity tags, and the chevron progress bars.

| Token | Value | Use |
|---|---|---|
| `surface` | `#ffffff` | main content background |
| `surface-sunken` | `#fcfcfd` | sidebar, activity feed panel |
| `surface-raised` | `#fdfdfe` | stage bar row |
| `surface-muted` | `#fafafa` | table footers, card headers |
| `surface-tile` | `#fbfbfc` | agent tile body, agent log panel |
| `text-primary` | `#101012` | body text, primary buttons, active nav |
| `text-secondary` | `#3f3f47` | secondary labels, data values |
| `text-tertiary` | `#6b6b73` | descriptions, inactive nav |
| `text-quaternary` | `#9a9aa2` | mono metadata, placeholders |
| `text-disabled` | `#b4b4ba` | timestamps, unreached labels |
| `border-strong` | `#d3d3d8` | secondary button borders, ticks |
| `border` | `#e3e3e6` | default hairline (cards, inputs) |
| `border-subtle` | `#ececee` | shell dividers (header, sidebar) |
| `border-faint` | `#f2f2f3` | in-table row dividers |
| `fill-inactive` | `#f4f4f5` | ghost button fill, placeholder stripes |
| `hover-primary` | `#2c2c31` | primary button hover |
| `hover-surface` | `#f7f7f8` / `#f4f4f5` | ghost/nav hover |

No shadows anywhere except one 1px-scale glow on the backward-moving progress dot (below).
Hairline borders only — no elevated card treatments.

### Color — item identity hues (the "legend")
Six moderately saturated hues in oklch, matched lightness/chroma, hue-varied. Each activity item
owns one hue and uses it consistently for: its progress dot + track label, its agent tiles'
border and chip, its shortlist/execution row dot, its execution progress fill, and its agent-log
tag. Nowhere else.

| Item | Hue token |
|---|---|
| Graphics card (GPU) | `oklch(0.55 0.15 258)` blue |
| Processor (CPU) | `oklch(0.55 0.16 22)` red |
| Motherboard (MB) | `oklch(0.55 0.11 196)` cyan |
| Memory (RAM) | `oklch(0.53 0.14 148)` green |
| Power supply (PSU) | `oklch(0.60 0.14 72)` amber |
| Case (CASE) | `oklch(0.52 0.17 318)` magenta |

Assign hues from this palette by index as items are created; six is the intended maximum before
recycling.

### Color — chevron progress ramp
Chevron progress bars fill on a warm ramp, index `i` of `count`:
`oklch(0.70 0.175 H)` where `H = 88 - 62 * (i / (count - 1))` — amber at the left through orange
to red at the right. Unfilled chevrons: `#e6e6e9`. Cancelled-activity fill: `#c4c4ca` flat gray.
Each chevron transitions `background 420ms ease` as the fill advances.

### Typography
Two families, loaded from Google Fonts:
- **Instrument Sans** (400 / 500 / 600) — all interface text.
- **IBM Plex Mono** (400 / 500) — every data-like element: prices, timestamps, URLs, agent ids,
  card numbers, wallet balance, stage labels, uppercase eyebrows, log lines.

The mono/sans split is a semantic rule, not decoration: if a value is machine-produced, it is
mono.

| Role | Spec |
|---|---|
| Empty-state h1 | 26px / 600 / `-0.025em` |
| Screen h2 | 20px / 600 / `-0.02em` |
| Wallet balance | mono 30px / `-0.02em` |
| Shortlist total | mono 19px |
| Profile name | 19px / 600 / `-0.02em` |
| Card/row title | 13.5–14px / 500 / `-0.01em` |
| Body | 14px / 1.45 |
| Body small / descriptions | 12.5–13.5px, `text-tertiary` |
| Button label | 12.5–13px / 500 |
| Eyebrow (uppercase) | mono 10.5px / `0.06–0.08em` / uppercase |
| Mono metadata | 10.5–11.5px |
| Micro (chips, tile ids, log tags) | mono 9–10.5px |

Base: `font-size:14px; line-height:1.45`. `text-wrap: pretty` on paragraph copy.

### Spacing, radius, motion
- Spacing rhythm: 2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 22 / 26 / 28 px. Screen padding
  `26–28px 30px 34–40px`. Card padding `12–20px`. Generous whitespace throughout.
- Radius: 4px (chips, micro tags) · 5px (agent tiles, small controls) · 6px (buttons, nav items,
  inputs) · 8px (cards, panels) · 12px (composer) · 14px (chat bubble, with a 4px tail corner) ·
  999px (pills, toggles) · 50% (dots, avatars). Quiet and small — never 16px+ on a card.
- Motion: sidebar width `200ms cubic-bezier(.22,.61,.36,1)`; message entry `h-in` 260ms
  (6px rise + fade); toggles `180ms ease`; execution progress fill `500ms cubic-bezier(.22,.61,.36,1)`;
  chevron fill `420ms ease`; row background `300ms ease`; tile opacity `400ms ease`.
- Keyframes used: `h-scroll` (agent tile content scroll, translateY 0 → -50%, 7–9s linear
  infinite), `h-shimmer` (grid cell opacity .35 ↔ .85, 2–2.8s), `h-blink` (live indicator
  opacity 1 ↔ .15, 1–1.2s), `h-in` (entry), `h-sweep` (available, unused).
- **Accessibility is part of the spec**: a `prefers-reduced-motion: reduce` block collapses all
  animation and transition durations to `.001ms` and iteration counts to 1 — the flow must remain
  fully legible with motion off, which means every animated state also reads as a static state.
  Focus is `2px solid #101012` at `2px` offset via `:focus-visible`, never removed.

## Shell Layout

A fixed-viewport three-region app: sidebar / main column / activity feed.

```
┌────────┬──────────────────────────────────────┬──────────────┐
│ 216px  │ header 56px                          │              │
│ nav    ├──────────────────────────────────────┤  312px       │
│ (60px  │ stage bar (chevron stepper) ~40px    │  Activity    │
│  when  ├──────────────────────────────────────┤  feed        │
│  coll- │                                      │  (hidden     │
│  apsed)│ screen content (scrolls)             │   when an    │
│        │                                      │   activity   │
│        │                                      │   is focused)│
└────────┴──────────────────────────────────────┴──────────────┘
```

### Sidebar (216px open / 60px collapsed)
`#fcfcfd`, right border `#ececee`, `overflow:hidden`, width transitions 200ms.
- Brand row, height 56px, padding `0 14px`, bottom border `#ececee`: 20×20 `#101012` square at
  5px radius + "Happy" 600 weight. Label hides when collapsed.
- Nav: Purchase / Wallet / Mandate / Settings. Each row `8px 9px`, 6px radius, 10px gap,
  16×16 stroke icon (1.4 stroke width, `currentColor`), 13px label. Active: `#f0f0f1` background,
  `#101012` text, 500 weight. Inactive: transparent, `#6b6b73`, 400.
- Footer (`margin-top:auto`, top border): Collapse toggle, same row geometry, `#6b6b73`,
  hover `#f4f4f5` + `#101012`.

Icons are simple 16×16 stroke glyphs: bag (Purchase), card (Wallet), shield (Mandate), gear
(Settings), panel (Collapse), chevron-left (Back), arrow-up (Send). Replace with the codebase's
icon set.

### Header (56px)
Padding `0 20px`, bottom border `#ececee`, 16px gap.
- Back button (only when an activity is focused **and** the Purchase screen is active): chevron-left
  13px + "Back", `5px 10px 5px 8px`, 1px `#e3e3e6` border, 6px radius, 12.5px `#3f3f47`; hover
  border+text `#101012`.
- Title: 500 weight, `-0.01em`, single-line ellipsis. Per screen: the activity name during a flow,
  the archived activity name in archive view, otherwise "Wallet" / "Mandate" / "Settings" /
  "Profile".
- Meta beside it: mono 11px `#9a9aa2` — `draft`, `step 1 of 5 · wishlist`, `step 2 of 5 ·
  clarification`, `step 3 of 5 · search`, `step 4 of 5 · confirmation`, `step 5 of 5 · execution`,
  or the archived activity's timestamp.
- Right: 28px circular `#101012` avatar, white 11px 600 initials "TL" → navigates to Profile.

### Stage bar (Purchase screen, not in archive view)
Its own row under the header: `9px 18px`, bottom border `#ececee`, background `#fdfdfe`, 6px gap,
wraps.

Five clickable groups — `chat`, `list`, `search`, `pick`, `buy` — each: a row of **8 chevrons**
(2px gap) + a mono 10px uppercase `0.08em` label, laid out `4px 8px` with 9px gap. The active
group has a `#d7d7db` border and `#fafafa` background; others have a transparent border (so
nothing shifts). Label color: active `#101012`, completed `#6b6b73`, unreached `#b4b4ba`.
Clicking a group jumps the prototype to that stage — in production this is either navigation or a
demo-only affordance; decide with the product owner.

### Chevron progress bar (shared visual language — implement once, reuse)
The core progress primitive, used at three sizes. A row of chevrons, each:
```
width: 7px; height: 12px; flex: none; display: block;
clip-path: polygon(0 0, 52% 0, 100% 50%, 52% 100%, 0 100%);
background: <ramp color | #e6e6e9 | #c4c4ca>;
transition: background 420ms ease;
```
Given a fraction 0–1 and a count, `filled = round(fraction * count)`; chevrons below that index
take the warm ramp color for their index, the rest `#e6e6e9`.

| Instance | Count | Gap | Label |
|---|---|---|---|
| Stage bar group | 8 per group (5 groups = 40 total) | 2px | group name below-right, mono 10px uppercase |
| Activity feed card | 26 | 1.5px | mono 9px `0.1em` uppercase status under the bar |
| Archive summary | 40 (wraps) | 2px | mono 10.5px uppercase + total on the right |

Fraction sources: stage bar → current stage index plus intra-stage partial, over 5. Feed card →
same, or 1 when complete, 0 when not started. Archive → 1 for completed, 0.45 for cancelled.
Intra-stage partial: during search, the furthest-along item's path progress; during execution,
`execStep / (itemCount * 4)`; otherwise 0.5.

### Activity feed (312px, right)
`#fcfcfd`, left border `#ececee`. Header row `16px 18px 12px`: mono uppercase "Activity" eyebrow
+ a 24×24 "+" button (1px `#e3e3e6`, 6px radius) that starts a new activity. Scrolling list,
`0 14px 18px`, 8px gap.

Each card is a full-width left-aligned button, 1px border, 8px radius, white, `12px 13px`; the
active/current activity's border is `#101012`:
- Row 1: 7px status dot + 13px 500 title (`-0.01em`). Live dot `#3f3f47` with `h-blink`;
  completed `#101012`; cancelled `#c9c9cf`.
- Row 2 (9px above): state chip + mono 10px `#b4b4ba` timestamp pushed right. Chip is mono 9.5px
  uppercase `0.06em`, `3px 6px`, 4px radius — completed: `#101012` fill / white text; live:
  white / `#3f3f47` / `#d3d3d8` border; archived: `#fafafa` / `#e3e3e6`.
- Row 3 (10px above): 26-chevron progress bar + status label — `drafting…`, `searching…`,
  `awaiting you…`, `purchasing…`, `complete`, `stopped at shortlist`.

Clicking a card focuses that activity (see Interactions). Dummy content: the live "Budget gaming
PC build", then "Restock pantry — 12 items" (Aug 12, completed), "Standing desk under S$700"
(Aug 09, completed), "Birthday gift for Mei" (Aug 04, cancelled), "Monthly contact lenses"
(Jul 28, completed).

## Screens

### 1. Dashboard / chat (empty state)
Centered column, `max-width:720px`, `0 28px`, scrolls; composer pinned at the bottom.

Empty state, `56px 0 24px`, centered:
- h1 26px 600: "What should we buy today?"
- 14px `#6b6b73`: "Hand over a list, or describe the outcome you want. Agents research, compare
  and check out with a single-use card."
- Three suggestion pills (wrapping, 8px gap, centered): `7px 12px`, 999px radius, 1px `#e3e3e6`,
  12.5px `#3f3f47`; hover `#f7f7f8` + `#d3d3d8`. Copy: "build me a budget gaming PC under
  S$1,600" · "restock my pantry, same brands as last month" · "here is a list of 8 things for a
  new apartment". Clicking fills the composer.

Composer: `12px 28px 22px`, top border `#f2f2f3`. Inner row 1px `#e3e3e6`, 12px radius,
`8px 8px 8px 14px`, borderless 14px input, 32×32 `#101012` send button (8px radius, arrow-up
glyph). Placeholder: "Give me a list, or tell me a goal — "build me a budget gaming PC under
S$1,600"". Enter submits. Under it, mono 10px `#b4b4ba`: "Mandate active · auto-approve under
S$600/item · card issued per purchase".

### 2. Chat messages
22px between messages, each entering with `h-in` 260ms.
- **User**: right-aligned, max 76% width, `10px 14px`, `#101012` fill, white text, radius
  `14px 14px 4px 14px`.
- **Assistant**: 12px gap row — 22px `#101012` rounded square (6px radius) avatar + content column.
- **Thinking**: 6px `#101012` dot with `h-blink` + mono 11px `#9a9aa2` label, e.g. "decomposing
  goal into a wishlist". Shown ~1100ms before the reply lands.

### 3. Wishlist approval (goal decomposition)
Assistant text: "Six parts get you a solid 1080p build. Prices are current Singapore street
prices, total lands near S$1,285 — inside your budget with room for a cooler if you want one."

Then a bordered card (1px `#e3e3e6`, 8px radius, overflow hidden):
- Header `11px 14px`, `#fafafa`, bottom border: "Proposed wishlist" 12.5px 600 + mono 10.5px
  "est. S$1,285 · cap S$2,500" right.
- One row per item, `11px 14px`, 12px gap, bottom border `#f2f2f3`: 8px item-hue dot ·
  name 13.5px 500 + mono 10.5px `#9a9aa2` spec · mono 11.5px budget right · (edit mode) a
  22×22 "×" remove button.
- Footer `12px 14px`, `#fafafa`, 10px gap: in edit mode an "Add an item, e.g. 240mm AIO cooler"
  input + "Add" button; then "Edit list"/"Done editing" secondary button; "Approve & continue"
  primary pushed right (`8px 16px`, `#101012`, white, 6px radius, hover `#2c2c31`).

Wishlist data: Graphics card — RTX 4060 class, 8GB, S$430 · Processor — Ryzen 5 / Core i5, 6
cores, S$285 · Motherboard — B650 mATX, DDR5, S$205 · Memory — 16GB DDR5-6000 kit, S$120 ·
Power supply — 650W 80+ Gold, S$135 · Case — mATX airflow, mesh front, S$110.

Approving appends a user message "Looks right — go ahead." and the first Curator card.

### 4. Item clarification (Curator)
Per ambiguous item, an in-chat card set. Header row: 8px item-hue dot + mono 10.5px uppercase
"Curator · <item name>". Options in `repeat(auto-fit, minmax(180px, 1fr))` grid, 12px gap.

Each option card: 1px border (`#101012` when chosen, else `#e3e3e6`), 8px radius —
- 96px image placeholder: `repeating-linear-gradient(135deg, #f4f4f5 0 6px, #ececee 6px 12px)`
  with a centered mono 9.5px `#9a9aa2` label ("gpu · 4060"). **These are placeholders awaiting
  real product imagery** — see Assets.
- Body `11px 12px 12px`: name 13px 500 · mono 11px price range · 12px `#6b6b73` rationale ·
  full-width Choose button (`#f4f4f5` / `#101012` text; when chosen `#101012` / white, label
  "Locked").

Below: two 999px ghost pills — "Ask a follow-up", "You decide".

Two are shown in sequence so locked items accumulate visibly:
1. Graphics card — "RTX 4060 8GB" S$399–489 ("Best 1080p per dollar with DLSS 3 and low power
   draw.") · "RX 7600 8GB" S$359–429 ("Cheaper raster, weaker ray tracing and upscaling.") ·
   "Arc B580 12GB" S$379–419 ("More VRAM, driver maturity still uneven on older titles.")
2. Case — "mATX mesh airflow" S$95–135 ("Coolest option; front mesh trades some fan noise
   damping.") · "mATX tempered glass" S$105–159 ("Looks better on a desk, runs 3–5°C warmer.") ·
   "Compact ITX-style" S$139–189 ("Small footprint, tight GPU clearance for a 2-slot card.")

After the second pick: a "Locked items" panel (1px border, 8px radius, `12px 14px`, mono
uppercase eyebrow, one 13px row per locked item with hue dot and mono range), assistant text
"That is everything ambiguous resolved. The other four are spec-bound, so agents can search them
directly. Twelve agents, two per item, each working its own candidate listings.", and a
"Dispatch agents" primary button.

### 5. Multi-agent search — THE SIGNATURE SCREEN
Spend the most craft here. Padding `26px 30px 34px`.

**Header row** (wraps): eyebrow "Multi-agent search" + h2 "Budget gaming PC build"; right cluster
in mono 11px `#6b6b73`, `10px 18px` gap: "6 items · 12 agents" · "t+42s" elapsed · a blinking
`#101012` dot with "live"/"paused" · a pause/resume button (`5px 10px`, 1px `#e3e3e6`, 6px radius,
mono 10.5px).

**Collective progress track** — 1px `#e3e3e6`, 8px radius, `18px 20px 14px`, `margin-bottom:22px`.
Inner wrapper is `overflow-x:auto` around a `min-width:540px` block so the five stops never
collide:
- Stop headers: five 20%-wide cells, `space-between`, mono 10px uppercase `0.06em` `#9a9aa2`,
  first left-aligned, last right-aligned, middle three centered — **Discovering · Analyzing ·
  Gathering · Comparing · Selected**. 14px below.
- The track: a 1px `#e3e3e6` full-width rule with five 1×7px `#d3d3d8` ticks at
  `left: calc(i/4 * 100% - i/4 * 2px)`, `top:-3px`.
- One 20px-tall lane per item, each holding that item's dot and label positioned at
  `left: calc(pct - pct/100 * 11px)` where `pct = stageIndex / 4 * 100`.

**The dot** — 11px circle, item hue, 1px `rgba(0,0,0,.08)` border, `z-index:2`. Queued (agent not
yet dispatched): white fill with a 1px dashed `#c9c9cf` border.

**Forward vs backward motion is the point of this screen.** An item that loops from Gathering back
to Discovering — an agent going to check another candidate listing before it has enough to
compare — must read as deliberate, not as a glitch:
- Forward: `left 850ms cubic-bezier(.22,.61,.36,1)` — quick, decisive ease-out.
- Backward: `left 1450ms cubic-bezier(.7,-0.4,.3,1.4)` — slower, with anticipation and overshoot,
  **plus** `box-shadow: 0 0 0 5px color-mix(in oklab, <item hue> 22%, transparent)` (a soft glow
  ring, transitioned `600ms ease`). Forward moves carry no glow.
- The item's mono 9.5px label travels alongside, offset `translateX(16px)` from the dot, flipping
  to `translateX(calc(-100% - 8px))` past 70% so it never clips at Selected. **It must share the
  exact same transition string as the dot** — a separate duration desynchronises label from dot
  mid-flight and the motion stops reading.

**Legend** below the track, above a `#f2f2f3` divider, `14px 20px` wrapping gap: per item an
8px hue chip + 12px name + mono 10.5px current stage; while moving backward, an extra mono 10px
"re-check ↩" chip (1px `#e3e3e6`, 4px radius, `1px 5px`, `white-space:nowrap; flex:none`).

**Agent tiles** — `repeat(auto-fill, minmax(210px, 1fr))` grid, 14px gap. Two agents per item, the
second trailing one stage behind the first, so items sit at different stages simultaneously.

Each tile: **1.5px solid item-hue border**, 5px radius, white; `opacity:.45` while queued
(transition 400ms).
- Fake browser chrome, `5px 7px`, white, bottom border `#f0f0f1`: 6px hue chip + mono 9px
  `#9a9aa2` truncated URL (`bizgram.com.sg/rtx-4060`, `dynacore.com.sg/ryzen-7600`,
  `sim-lim.sg/b650m`, `shopee.sg/kingston-fury`, `lazada.sg/mwe-650-v2`,
  `bizgram.com.sg/lancool-205m`; the second agent appends `?p=2`).
- 118px viewport, `#fbfbfc`, `overflow:hidden`, in one of two mocked modes:
  - **Scrolling page** (most tiles): 18 stacked gray bars (`7px 8px` padding, 5px gap) —
    every 5th 7px tall `#dcdce0`, the rest 4px `#eeeef0`, widths `48% + (i*37 % 52)%` — animated
    `h-scroll` (translateY 0 → -50%) at 7–9s linear infinite.
  - **Result grid** (every third tile): 3×3 of 26px `#f1f1f3` cells (every 4th `#e4e4e8`), 3px
    radius, each `h-shimmer` 2–2.8s with a staggered `0.12s * i` delay.
  - Both overlaid with `linear-gradient(180deg, transparent 55%, rgba(255,255,255,.92))` so
    content fades out at the bottom.
- Footer `8px 9px 9px`, top border `#f0f0f1`: mono 10px agent id (`ag-1014`-style hex) + mono
  10px `#b4b4ba` stage right; below, 11.5px `#6b6b73` truncated "<item name> · <action>".
  Actions by stage: crawling listing pages / reading spec table / pulling seller history /
  diffing 6 candidates / locked candidate; queued reads "waiting for a slot".

**Auto-advance**: every `tickMs` (default 1500ms, tweakable 700–3500) each item steps to the next
entry in its own stage path. Paths are authored per item so the screen shows a mix of stages and
three distinct backward loops (Gathering → Discovering):
```
GPU  [0,1,2,0,1,2,3,4]   start tick 0    CPU  [0,1,2,3,3,4]       start 0
MB   [0,0,1,2,0,1,2,3,4] start 1         RAM  [0,1,1,2,3,4]       start 0
PSU  [0,1,2,2,3,4]       start 2         CASE [0,1,2,0,0,1,2,3,4] start 1
```
When every item reaches Selected, the screen auto-advances to the shortlist after 1400ms. Pause
stops the timer without losing position. In production these ticks are server-pushed agent
events; keep the path/loop concept, since real agents genuinely revisit earlier stages.

### 6. Shortlist — confirmation
`max-width:860px`. Eyebrow "Shortlist", h2 "One pick per item, ready for checkout", 13.5px
`#6b6b73`: "Agents compared 214 listings across 9 sellers. Reject any pick to send its agents back
out."

Bordered list, one wrapping row per item (`14px`, 14px gap, bottom border `#f2f2f3`):
74×58 striped image placeholder (4px radius, mono 8.5px label) · a `flex:1 1 260px; min-width:190px`
block with an 8px hue dot + mono 10px uppercase item name, then 14px 500 listing title, mono 11px
"seller · rating · review count", 12.5px `#6b6b73` rationale · right column with mono 14px price
and a "Reject & re-search" button (`5px 10px`, 1px `#e3e3e6`, 6px radius, 11.5px `#6b6b73`, hover
`#101012`) that becomes "re-searched" and swaps in the alternate listing.

Listings:
| Item | Title | Seller | Rating | Price | Why |
|---|---|---|---|---|---|
| GPU | ASUS Dual RTX 4060 OC 8GB | Bizgram Asia | 4.8 · 1,204 reviews | S$429.00 | Cheapest in-stock 4060 from a seller with a local RMA counter. |
| CPU | AMD Ryzen 5 7600 (boxed) | Dynacore Sim Lim Sq. | 4.9 · 863 reviews | S$279.00 | Boxed cooler included, S\$18 under the next listing. |
| MB | MSI PRO B650M-A WiFi | Bizgram Asia | 4.7 · 512 reviews | S$199.00 | Only mATX B650 under S\$210 with WiFi 6E and 4 DIMM slots. |
| RAM | Kingston Fury Beast 16GB DDR5-6000 | Shopee · TechDeals.SG | 4.8 · 3,417 reviews | S$112.00 | EXPO profile matches the board QVL; 12-month local warranty. |
| PSU | Cooler Master MWE Gold 650 V2 | Lazada · CM Official | 4.9 · 2,088 reviews | S$129.00 | Fully modular at the price of the semi-modular rivals. |
| CASE | Lian Li Lancool 205M Mesh | Bizgram Asia | 4.6 · 741 reviews | S$105.00 | Two 140mm intakes stock, clears the Dual 4060 by 40mm. |

Re-search alternates: GPU → Gigabyte RTX 4060 WINDFORCE OC, Lazada · Gigabyte Store, 4.7 · 968
reviews, S$449.00, "Re-searched pick: quieter cooler, S\$20 more." · CPU → Intel Core i5-13400F,
Bizgram Asia, 4.8 · 1,102 reviews, S$268.00, "Re-searched pick: cheaper, needs an aftermarket
cooler."

Footer `16px`, `#fafafa`, 16px gap: "Total" eyebrow + mono 19px sum · mono 10.5px `#9a9aa2`
two-line note "cap S$2,500 / activity · under by S\$1,247.00" / "card: single-use XSGD virtual ·
expires 60 min" · "Confirm & purchase" primary (`11px 20px`, 13px 500) pushed right.

### 7. Purchase execution — live feed
`max-width:820px`. Same observable language as search, simpler: no video tiles. Eyebrow "Purchase
execution", h2 "Buying 6 items, one card each" → "All orders placed"; right mono 11px
"sequential · single-use card per order" → "completed 14:41 · S$1,253.00".

Per-item rows (bordered list, wrapping, `13px 16px`, 14px gap; active row background `#fbfbfc`,
300ms):
9px hue dot (`opacity:.3` until started) · item name 13.5px 500 + mono 10.5px truncated listing
title (`flex:1 1 180px`) · a `flex:1 1 150px; max-width:210px` step block — mono 10.5px step label
over a 2px `#ececee` rail with an item-hue fill at `step/4 * 100%`, `width 500ms
cubic-bezier(.22,.61,.36,1)` · mono 12px price · a state chip (mono 10px uppercase, `3px 7px`,
4px radius): `QUEUED` (white / `#9a9aa2`), `LIVE` (white / `#3f3f47`), `PURCHASED`
(`#101012` / white).

Four steps per item, advancing every 620ms, strictly sequential across items:
`requesting card → entering checkout → confirming order → order confirmed` (label "complete" once
done).

Agent log panel below (1px border, 8px radius, `#fbfbfc`, `14px 16px`): mono uppercase eyebrow
"Agent log", then mono 11.5px lines, 5px gap, entering with `h-in` 200ms, last 14 kept. Each line:
`#b4b4ba` `HH:MM:SS` timestamp (starting 14:32:08, +3s per line) · a 40px item-hue mono 10px tag
(`GPU`, `CPU`, …) · `#3f3f47` text. Message forms:
`card 4319 4400 issued · limit S$429.00` · `bizgram-asia/checkout · autofill ok` ·
`placing order S$429.00` · `order #SG830142 confirmed · card expired`.

Completed panel (1px border, 8px radius, `18px 20px`): "All 6 items purchased" 15px 600 + mono
11px "S$1,253.00 charged · 6 single-use cards expired · activity moved to Completed"; right,
"Start another activity" secondary and "View in wallet" primary. On completion the wallet balance
decreases by the total and the feed card flips to Completed.

### 8. Archived activity (focused past activity)
`max-width:760px`. Eyebrow "<state> activity", h2 title. A summary panel (1px border, 8px radius,
`16px 18px`): 40-chevron bar (wrapping, 2px gap) over a mono uppercase label ("all items
purchased" / "cancelled at shortlist") with the total right-aligned in 12px `#101012`. Then a
bordered line-item list (wrapping rows, `13px 16px`): name 13.5px 500 + mono 10.5px seller,
mono 12px price right.

Archive data — Restock pantry (12 Aug 2026 · 09:22, S$186.40): Jasmine rice 5kg / FairPrice
Online / S$14.90 · Kikkoman soy sauce 1L / Redmart / S$9.20 · Milo refill 1.8kg / FairPrice
Online / S$21.50 · Olive oil 750ml / Redmart / S$18.80 · "+ 8 more items" / mixed sellers /
S$122.00. Standing desk (09 Aug · 17:48, S$649.00): Ergotune Sit-Stand Pro 140cm / Ergotune SG.
Birthday gift for Mei (04 Aug · 11:02, cancelled, S$0.00): "Cancelled at shortlist — nothing under
cap". Monthly contact lenses (28 Jul · 20:15, S$96.00): Acuvue Oasys 6-pack ×2 / Lazada · Acuvue
Official.

### 9. Wallet
`max-width:900px`. h2 "Wallet". Two side-by-side panels (`flex:1; min-width:280px`, 16px gap,
1px border, 8px radius, `18px 20px`):
- **Balance**: mono uppercase eyebrow "XSGD balance"; mono 30px `-0.02em` amount (4,820.50);
  mono 11px `#9a9aa2` "≈ S$4,820.50 · 0x8f…c14b · Polygon"; "Top up" primary + "Withdraw"
  secondary (`9px 15px`). Top up adds 500.00 and shows a mono 11px receipt strip (1px border,
  6px radius, `8px 10px`, `#fafafa`): "+500.00 XSGD received · tx 0x4c…9ae1 · 3 confirmations".
- **Disposable cards**: eyebrow "Disposable cards", then rows of mono 11.5px masked PAN + mono
  10.5px amount + a status chip (used = `#101012`/white; issued/viewed = white/`#3f3f47`;
  expired = `#ececee` border): 4319 •••• 4402 S$429.00 used · 4398 S$279.00 used · 4386 S$120.00
  expired · 4371 S$689.00 issued · 4355 S$42.60 viewed. **Status lifecycle: issued → viewed →
  used → expired.**

Transactions: mono uppercase eyebrow, then a bordered list, `12px 16px` rows, 14px gap — mono
11px `#9a9aa2` 112px timestamp · 13px label · mono 11px reference · mono 12.5px 96px
right-aligned amount (debits `#101012`, credits `#3f3f47`):
15 Aug · 14:33 / Card authorisation · Bizgram Asia / auth 4402 / −S$429.00 · 15 Aug · 14:10 /
Top-up from DBS ••4471 / 0x4c…9ae1 / +S$500.00 · 12 Aug · 09:22 / Pantry restock · 12 items /
act 0f31 / −S$186.40 · 09 Aug · 17:48 / Standing desk · Ergotune / auth 4310 / −S$649.00 ·
04 Aug · 11:02 / Refund · cancelled activity / act 0e88 / +S$78.00 · 28 Jul · 20:15 / Contact
lenses · Lazada / auth 4288 / −S$96.00.

### 10. Mandate
`max-width:720px`. h2 "Mandate" + 13.5px `#6b6b73` "What agents may spend without asking.
Anything outside these rules pauses for your approval."

Bordered panel, `16px` rows, 16px gap, `#f2f2f3` dividers:
- "Auto-approve purchases" / "Agents check out without a final tap when every rule below passes."
  → toggle, **default ON**.
- "Per-item cap" / "Highest single line item an agent may buy." → range 100–1500 step 50, default
  600, 180px wide, `accent-color:#101012`, mono 12.5px "S$600" in an 82px right-aligned cell.
- "Per-activity cap" / "Total across all items in one activity." → range 500–6000 step 100,
  default 2500, same treatment. This value feeds the wishlist card's "cap S$…" and the shortlist
  footer's headroom calculation.
- "Category rules" / "Optional. Tap to switch a category between allowed, ask first, and blocked."
  → wrapping 999px chips (`6px 11px`, 12.5px) cycling allowed → ask first → blocked on click.
  Allowed: white, `#101012` border. Ask first: white, `#e3e3e6` border. Blocked: `#f4f4f5` fill,
  `#9a9aa2` text. Defaults: Electronics allowed · Groceries allowed · Apparel ask first · Travel
  ask first · Collectibles blocked.

**Toggle spec** (used here and in Settings): 38×22 track, 999px radius, 2px padding, flex-end when
on; on = `#101012` fill and border with a 16px white knob; off = white fill, `#d3d3d8` border,
`#c9c9cf` knob; `180ms ease`.

### 11. Settings
`max-width:660px`. h2 "Settings". Bordered panel, `15px 16px` rows: name 13.5px 500 + 12.5px
`#6b6b73` description, with either a toggle or a mono 12px value right-aligned.
- "Push notifications" / "Alert me when an agent pauses for approval." → toggle, default ON.
- "Sandbox mode" / "Run agents end-to-end without issuing real cards." → toggle, default OFF.
- "Region & currency" / "Used for listings, taxes and shipping estimates." → "Singapore · SGD".
- "Data retention" / "How long agent transcripts and screenshots are kept." → "90 days".

### 12. Profile
`max-width:660px`. 56px circular `#101012` avatar with 18px 600 "TL" + name 19px 600 and mono
11.5px "tricia.lim@hey.sg · member since Mar 2026". Bordered key/value list (`14px 16px` rows,
150px 13px `#6b6b73` key, mono 12px value): Name Tricia Lim · Email tricia.lim@hey.sg · Linked
wallet 0x8f41c2ba9d7e5f30a6b1d4c9e2f7a8b0c14b · Wallet network Polygon · XSGD · Passkey MacBook
Pro · added 12 Jun 2026 · Agent identity happy-agent/1.4 (tricia-lim). Then a "Sign out"
secondary button (`10px 16px`, hover `#101012`).

## Interactions & Behavior

### Primary flow
1. Dashboard → type or pick a suggestion → send (button or Enter).
2. Assistant thinking state ~1100ms → wishlist card. Edit mode adds/removes items.
3. "Approve & continue" → user echo message + Curator card for the graphics card.
4. Choosing an option locks it (button → "Locked") and appends the next Curator card (case).
   "You decide" picks the first option. After the second pick: Locked-items panel + "Dispatch
   agents".
5. "Dispatch agents" → search screen, timer starts, auto-advances every `tickMs`; pause/resume
   available; all items Selected → 1400ms → shortlist.
6. Shortlist: reject swaps in an alternate listing and re-labels the button; "Confirm & purchase"
   → execution.
7. Execution: 4 steps × N items at 620ms each, log accumulating; completion updates the wallet
   balance, marks the activity Completed and reveals the completion panel.

### Focus / navigation model
- Clicking an activity card **focuses** it: the right feed is hidden, the main column is dedicated
  to that activity, and a Back button appears in the header.
- Focusing the live activity restores its current stage and conversation. Focusing a past activity
  opens the archive view.
- **Back** (or clicking the Purchase tab) unfocuses: the conversation is stashed, the chat returns
  to its empty state, and the feed reappears — the in-flight activity keeps running and is
  restored intact when its card is clicked again. Header title/meta and Back render only on the
  Purchase screen, so Wallet/Mandate/Settings/Profile always show their own title while the
  focused activity is remembered.
- The "+" button in the feed header resets everything to a fresh activity.
- Sidebar nav switches screens without disturbing a running activity; the collapse toggle only
  changes width.
- The stage bar's five groups jump the flow to that stage with seeded mock data — a demo
  affordance to review with the product owner before shipping.

### Feed state derivation
The feed chip and the card's chevron fraction must be computed from the **same** effective stage
(the running activity's stage, which survives leaving the screen), never from the currently
displayed view — otherwise a card can read "drafting" while its bar shows search progress.

### Accessibility
`prefers-reduced-motion` collapses all animation; `:focus-visible` shows a 2px `#101012` ring at
2px offset; icon-only controls (send, collapse, toggles, new activity) carry `aria-label` or
`title`; keyboard: Enter submits the composer and the add-item field.

## State Management

Prototype state, and its production equivalent:

| State | Purpose | In production |
|---|---|---|
| `screen` | purchase / wallet / mandate / settings / profile | route |
| `stage` | idle / wishlist / curate / search / shortlist / exec | derived from the activity record |
| `focused` | null / 'current' / archive id | route param (`/activity/:id`) |
| `actStage`, `actMsgs` | stash for the unfocused running activity | server-held; no stash needed |
| `msgs` | conversation entries (typed: user / thinking / wishlist / curator / locked / start) | messages API |
| `removed`, `chosen`, `rejected` | wishlist edits, curator picks, shortlist rejections | activity mutations |
| `tick` | search timer count driving every item's stage | server-pushed agent events |
| `playing` | timer paused | demo-only |
| `execStep`, `log` | purchase progress and log lines | order + event streams |
| `balance`, `toast` | wallet | wallet API |
| `autoApprove`, `itemCap`, `actCap`, `ruleState` | mandate | mandate API |
| `settingsState` | toggles | user preferences |
| `activityLive`, `activityDone` | feed card state | activity status |

Two demo props are exposed as tweaks: `autoPlay` (boolean, default true) and `tickMs` (range
700–3500, default 1500).

Derived values worth naming in the port: per-item stage and its `back` flag (current vs previous
path entry), the flow fraction feeding every chevron bar, and the effective stage described above.

## Assets
No real assets are used. Every product image is a **striped placeholder**:
`repeating-linear-gradient(135deg, #f4f4f5 0 6px, #ececee 6px 12px)` with a centered mono label
naming what belongs there (96px tall in curator cards, 74×58 in the shortlist). Replace with real
product imagery from the listing source; keep the same box sizes and radii.

Icons are hand-drawn 16×16 stroke glyphs standing in for a real icon set — substitute the
codebase's icon library (bag, card, shield, gear, panel, chevron-left, arrow-up).

Agent tile "video" is entirely mocked (scrolling bars / shimmering grid). If real agent
screencasts exist, they drop into the same 118px viewport behind the same fake browser chrome and
hue border; if not, keep this treatment — it reads as live without pretending to be a stream.

Fonts: Instrument Sans and IBM Plex Mono, both Google Fonts (weights 400/500/600 and 400/500).

## Files
- `Happy.dc.html` — the complete prototype: all screens, mock timers, dummy data. Open directly
  in a browser.
- `support.js` — the prototype's template runtime. Needed only to run the HTML locally; **do not
  port it**.
