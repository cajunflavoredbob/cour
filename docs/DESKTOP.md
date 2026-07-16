# Desktop scope of work (0.14.0, first draft)

The owner's brief (2026-07-07): "polish the desktop... use your best
judgement for the first draft. Reason it well, consider the UX."
This lifts the mobile-only constraint that has governed since 0.9.1.

## The reasoning

cour's screens were designed for a 390px phone. Uncapped on a monitor
they stretch grotesquely: list rows spanning 1900px, a full-bleed
poster the size of a door with a tiny sheet at the bottom. The fix is
NOT a redesign -- the product, flow, and components are proven on
mobile -- it is re-layout: give each screen the shape that its job
takes at desk distance, reusing the same parts.

Reference points, per screen archetype:

- **The deck** (browse one title deeply, decide): the closest desktop
  ancestor is the **Steam store page** -- media gallery on one side,
  facts and actions beside it -- which is already the media box's
  design reference on mobile. Tinder web (the verdict paradigm's
  home) instead centers a phone-shaped card in dead space; that
  wastes exactly the room that makes desktop worth polishing. Verdict
  choice: two-pane stage. The killer consequence: **the bottom sheet
  disappears on desktop** -- the details it hides are simply always
  visible in the right pane. Progressive disclosure is a small-screen
  compromise, not a virtue to preserve.
- **Review / Rank ledgers** (scan a list, act on rows): Letterboxd
  and AniList's list views both settle near a 600-700px centered
  column -- wide enough for a thumb + title + meta + action, narrow
  enough to scan. Grids were considered and rejected: these are
  ordered ledgers (rank ORDER is the content), and grids erase order
  legibility.
- **Join** (one small form): centered column, generous whitespace,
  the watermark already scales. Every auth screen on the web.

## What ships in this draft

1. **Breakpoint**: one, `min-width: 900px` ("desktop"), via a
   `useMediaQuery` hook where layout must actually change component
   trees, plain media queries where CSS suffices. Below it, nothing
   changes -- mobile stays exactly as shipped.
2. **DeckDetails extraction**: the sheet's panel content (media box
   with the full PV state machine, thumb strip, title block,
   synopsis, links) becomes its own component, used by the sheet on
   mobile and mounted directly on desktop. Pure refactor; behavior
   frozen by the existing DeckSheet test suite.
3. **Desktop deck stage**: header row (progress chip / room stack /
   avatar) at normal document flow; below it a two-pane stage --
   poster card left (2:3, radius 16, the guide's poster shadow; the
   card-exit crossfade + verdict wash move with it), DeckDetails +
   verdict row right. Max stage width ~1120px, centered.
4. **Keyboard verdicts** (desktop only): L = Like, S = Skip,
   D = Dislike, ignored while any input/dialog has focus. A quiet
   mono hint row under the verdict row. Rationale: the guide's
   "buttons, not gestures, decide" is about *commitment being
   explicit* -- a deliberate keypress is a button in spirit, and
   desks have keyboards.
5. **Ledger columns**: Review and Rank cap at 680px centered above
   900px; their sticky action bars constrain to the column. Row
   hover states (background lift) -- desktops point, phones tap.
6. **Join**: form column capped and vertically balanced; nothing
   else -- it already works.

## Explicitly out (this draft)

- Multi-column/grid layouts of any screen; side navigation; a
  desktop-specific deck "browse all" view. Wait for real use.
- Hover-preview of PVs on thumbnails (Steam does this; cost/benefit
  says later).
- Tablet-width tuning between 480-900px (the mobile layout is
  acceptable there).
- Any wire/server change: this is 100% client.

## Risks / to verify on a real monitor

- The poster pane's exit-flair timing against the pane (not
  full-bleed) geometry.
- DeckDetails synopsis height in the right pane (internal scroll cap
  may need loosening on tall viewports).
- Whether the keyboard hints read as clutter (one-line removal).

---

# Extension: the rest of the app (0.15.0)

The owner (2026-07-07): "extend the scope to the rest of the app... scope it
properly... be careful." The 0.14.0 pass only did the deck; Review,
Rank (editor + standings), and Join were left with column caps, which
read as a phone column floating in a dark field. This extends the
considered desktop treatment to every remaining screen.

Two taste forks were put to the owner; their calls, locked:
- **Standings = elevated list, NOT a podium.** Stays in cour's quiet
  editorial voice (guide 08: "the season chip does the celebrating").
  #1 gets real weight; 1/2/3 get medal color; the rest are clean rows.
- **Rank editor = add pointer drag-to-reorder, KEEP up/down buttons**
  as the accessible + keyboard fallback.

## Per screen

- **AppHeader (new shared component).** Brand (cour + kanji + room
  label) left, AccountMenu right, optional `leading` slot (the deck's
  progress chip / scope-back). Replaces the three ad-hoc desktop
  headers (deck/review/rank) with one. Desktop-only; mobile headers
  are unchanged per screen.
- **Review -> rail + main** (CSS grid reflow, one render tree; NO JS
  branch). Full-width AppHeader. Sticky left rail (~320px): season
  headline, progress bar, resume banner, and the lock-in button (out
  of the sticky footer -- primary action always visible). Right
  column: pile tabs + ledger. Collapses to the current single stack
  below 900px via grid-template-areas; mobile byte-identical.
- **Rank editor -> rail + main.** Left rail: headline, the 12/9/6/3/1
  point legend (proper legend, not a cramped caption), submit button.
  Right: the sortable list. Pointer drag-to-reorder (grab any row),
  up/down buttons retained. Drag is the highest-risk item -- isolated
  last so it can't block the rest.
- **Rank standings -> elevated list.** Full-width AppHeader. #1 is a
  larger, poster-forward, accent-bordered row; 1/2/3 carry medal color
  on the rank number; #4+ are clean ranked rows. A subtle reflow
  animation when a fresh ranking shifts the order (sells "UPDATES
  LIVE"; reduced-motion -> no animation).
- **Join -> centered card.** Vertically balanced; the form in a bg-1
  card (border + soft shadow) so it reads as a deliberate object, not
  floating text; watermark scaled up behind. NOT a split-hero -- a
  two-field form leaves the form side sparse. Decided, not forked.
- **Loading:** wordmark scales up on desktop. Trivial.

## Approach / breakpoint

Single 900px breakpoint, as 0.14.0. CSS reflow (grid areas) wherever the
same DOM can restyle -- Review, Rank editor layout, Join, Loading. JS
(`useMediaQuery`) only where the tree genuinely differs -- Rank
standings (#1 hero row vs. plain list) and the drag-reorder wiring.
Confirm dialogs, AccountMenu popover, toasts: already centered/anchored,
no change.

## Sequencing (risk isolated last)

AppHeader -> Review -> Join -> Loading (safe, high-consistency) ->
Rank editor layout -> Rank standings -> Rank drag-to-reorder (riskiest,
droppable without blocking the rest).

## Out (this pass)

Mobile standings podium/redesign; drag-reorder on touch (up/down stays
the mobile path); any wire/server change (100% client); tablet tuning
480-900px.
