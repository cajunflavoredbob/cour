# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

This project is a fork of [reely](https://github.com/cajunflavoredbob/reely)
at 0.5.23 + audit 16 (`bafe0c9`), repurposed as a seasonal anime picker: the room /
swipe / match engine is inherited; the Plex provider is being replaced by an
AniList-backed seasonal catalog. reely's release history lives in the reely
repository; this changelog starts fresh at 0.1.0.

---

## [1.3.2] - 2026-08-16

Docs release: the README shows the app now.

### Added
- README screenshots captured from a live 1.3.1 build: desktop join,
  deck, and final standings full-width, plus a mobile strip (join,
  hold-to-skip-all mid-animation, the rank editor, standings).
- The cour logo lockup as standalone SVGs (`docs/logo-dark.svg` /
  `docs/logo-light.svg`): the dotted mark plus the Shippori Mincho
  wordtype outlined to paths, so no font is needed to render it. The
  README's `<picture>` element serves the right ink per GitHub theme,
  replacing the plain-text heading.

## [1.3.1] - 2026-08-16

The last two Dependabot items: the deferred node 26 image major, taken
deliberately this time, and a zustand patch.

### Changed
- Docker base image node 24.19-slim -> 26.7.0-slim. The builder installs
  pnpm through the bundled npm (Node 25+ dropped corepack from the
  image). PR CI now runs the full typecheck/build/test matrix on BOTH
  node 24 (the `engines.node` floor promised to self-hosters running
  from source) and node 26 (what the image runs), and the release gate
  tests on 26; a compat break on either line surfaces before it ships.
- zustand 5.0.14 -> 5.0.15.

### Fixed
- Component tests crashed under Node 26: its experimental WebStorage
  defines a `localStorage` global that reads as undefined without a
  storage file, shadowing jsdom's storage in the test environment. A
  vitest setup file now installs a spec-shaped in-memory Storage when
  the DOM environment lacks a usable one.

## [1.3.0] - 2026-08-16

The Dependabot backlog (four dependency majors taken deliberately) plus
the audit pass that shook out what the upgrades disturbed.

### Changed
- express 4.22 -> 5.2. The SPA fallback route uses express 5's
  `'/{*splat}'` syntax (the bare `'*'` no longer parses), the poster
  handler declares its route params explicitly, and a new dispatch test
  pins the routing seam.
- react 18.3 -> 19.2 (react-dom and the type packages with it). The JSX
  type is imported from react directly now that the global namespace is
  gone.
- typescript 5.9 -> 7.0 (the native compiler). The server tsconfig moved
  to NodeNext module resolution (TS 7 removed the legacy node10 mode);
  emitted output remains CommonJS, so the runtime shape is unchanged.
- Docker base image node 24.16 -> 24.19-slim. The proposed node 26 jump
  is deferred until 26 reaches LTS: its image also drops the bundled
  corepack the builder stage uses, and taking it would force the CI and
  engines floor past the supported node 24 line.
- Runtime deps: helmet 8.3, js-yaml 5.3, ws 8.21.3. Tooling: vite 8.2,
  vitest 4.1.10, biome 2.5.8, tsx 4.23, @vitejs/plugin-react 5.2 (the
  4.x line never declared vite 8 peer support). CI actions: pnpm/
  action-setup 6.0.10 and docker/login-action 4.6.0, SHAs verified
  against the upstream tags.
- CI now runs on pull_request (the repo is public; fork PRs previously
  ran zero checks) with push CI narrowed to main so PR branches don't
  double-run. The workflow token stays read-only.
- Config parsing pins js-yaml's CORE_SCHEMA: `~` / `Null` / empty still
  mean null exactly as they did before the js-yaml 5 upgrade, while
  yes/no/on/off stay strings for the validator to reject. A blank or
  comments-only config file gets the standard "must be an object" boot
  error instead of a raw parser exception.

### Fixed
- A degraded AniList response with zero entries can no longer replace a
  serving deck or overwrite a good season snapshot on disk; past the
  list freeze that single response used to brick every join until the
  next rotation. An empty rotation fetch now defers the rotation for
  the hourly retry, and a boot-time refresh still in flight when the
  season rotates is discarded instead of stomping the new deck.
- A room evicted because it cannot re-deck now disconnects its
  connected members into the normal reconnect-and-rejoin flow; they
  previously kept verdicting the orphaned deck while their rows
  resurrected under the new season.
- The server refuses a name switch while a join is mid-flight, closing
  a window that installed room membership under the old name and left a
  ghost member the disconnect cleanup could never evict.
- Hold-to-skip-all: sliding a finger off the button now aborts the hold
  on touch (implicit pointer capture had made the abort gesture dead,
  so the 1.5s skip-all fired under a finger that slid away); a press
  whose buttons disable mid-hold can neither fire skip-all nor skip the
  next unseen card on release; a mouse release that started on a
  neighboring button no longer records a stray skip; and a cancelled
  system gesture cleans the press up.
- Standings refetch after a reconnect rejoin: counts labeled as live no
  longer serve stale data until someone else submits, and a submit
  whose ack died in a disconnect no longer traps the user in an editor
  whose resubmit the server refuses. A refused resubmit also refetches,
  so the standings replace the editor either way.
- Browsers with storage blocked no longer white-screen at boot
  (localStorage access is guarded throughout) and now survive
  reconnects: the automatic relogin and room rejoin fall back to the
  in-memory identity when nothing is stored.
- The cold-load auto-rejoin holds the loading screen instead of
  flashing the join form for a beat; if the ledger fetch exhausts its
  retries during that hold, the user lands on Home where the retry
  affordance actually renders.
- The ranking editor freezes during the three-second submit ceremony;
  edits made there were accepted visually and silently discarded.
- The share-room dialog no longer steals focus from its own link input,
  so the link is selected and ready to copy again.
- "Locking in..." can no longer stick forever when a season rotation
  replaces the ledger while the lock request is in flight.
- Two request timeouts in the same millisecond no longer collide on one
  toast id and dismiss together.
- The poster proxy omits content-length when the upstream image arrived
  content-encoded, instead of forwarding a compressed byte count for a
  stream fetch hands over decompressed.

### Removed
- Dead code: the web-side keystroke sanitizer module and the AniList
  reachability probe, along with their tests. The server-side sanitizer
  (the one actually in use) is untouched.
- @types/js-yaml: js-yaml 5 ships its own type declarations.

### Security
- `data.snapshot-*` directories (ad-hoc copies of the live database)
  are excluded from the Docker build context, mirroring the existing
  .gitignore rule, so they can never be baked into image layers.

## [1.2.3] - 2026-07-17

The audit-v1.2.0 low pile -- the final batch.

### Fixed
- Toasts render above every overlay (a Disconnected toast could hide,
  un-dismissable, under the lock-in dialog's scrim) and now use the
  cour palette instead of leftover pre-pivot tokens.
- "N OF M LOCKED" and the standings' WAITING ON list update the moment a
  new member joins the verdict flow instead of waiting for the next lock.
- A null or typeless WebSocket frame is dropped cleanly instead of
  throwing twice inside the server's message handler.
- Server failure messages speak to users ("Please try again") instead of
  telling them to check server logs they don't have.
- Visual drift: the resume-the-deck action is "Keep picking" everywhere;
  accent buttons all use white text; mobile standings show the season
  kanji and room name like every other screen.
- In-memory rooms with nobody connected are dropped at season rotation,
  making the room cap per-season instead of per-process-lifetime.

### Changed
- Season rotation timing is documented as server-clock/UTC, accepted
  as-is (hour-level precision is all the mechanism needs).
- A late joiner re-triggering the everyone's-locked celebration when
  they lock is documented as deliberate: it's true again.

### Removed
- Dead code: the Plex-era ProviderIcon, an orphaned Avatar sibling, the
  unused `accepts` dependency, and the last stale Plex-era comments.
  CONTRIBUTING no longer documents the removed i18n pipeline.

## [1.2.2] - 2026-07-17

The rest of the audit-v1.2.0 mediums.

### Fixed
- The review pills, Lock in, and Submit rankings now disable while
  disconnected, like the deck already did -- a confirmed lock-in can no
  longer silently not happen during an outage.
- Both one-shot finalizers show a committed in-flight state ("Locking
  in..." / "Submitting...") for a minimum of three seconds; the screen
  never flips out from under the ceremony, and a failure re-arms the
  button.
- Holding Enter or Space on a focused verdict button fires one verdict,
  not one per key-repeat tick; and after the deck advances, the buttons
  briefly settle so a double-tap can't verdict a card you never saw.
- Rank-editor dragging now rides an always-visible grip handle (the
  three-line affordance); the rest of the row is inert for dragging, so
  the list scrolls normally by touch on every platform.
- The daily pre-freeze snapshot refresh now re-decks open rooms (they
  could previously serve their creation-day deck until a restart), a
  room that fails to re-deck is evicted instead of mixing seasons, and
  a season rotation whose post-swap steps fail retries them on the next
  tick instead of half-landing forever.
- The post-lock "Back to standings" button styles as the live control it
  is instead of inheriting the disabled lock button's muted look.

### Removed
- The last of the filter machinery, root and branch: room filter state,
  persistence, the provider's filter application, and the wire fields
  that carried it. The deck-swap push is now a plain `mediaChanged`
  frame. Legacy `filters_json` values in old rows are inert and die with
  the rotation reaper.

## [1.2.1] - 2026-07-17

The audit-v1.2.0 fix release: both blockers, the top user-felt highs,
and the licensing restructure.

### Fixed
- The join screen's primary button referenced a CSS class that didn't
  exist, so the first button every user sees rendered unstyled. A test
  now pins the class, since typecheck can't see CSS-module typos.
- One corrupt filters_json row crash-looped the server on every boot
  (the rotation reaper maps all rooms through the parser). A bad row now
  degrades to no-filters and the sweep continues.
- Editing the pre-filled room on a ?roomName share link was silently
  ignored -- the URL's room beat what you typed. The typed room wins.
- A review fetch that died client-side (timeout, reply lost in a
  reconnect) never retried and stranded the screen on the loading pulse
  forever. Both failure paths now share the paced retry, and when the
  budget runs out a "couldn't load your season" screen offers a retry
  button instead of an infinite pulse.
- Season rotation is no longer silent: connected users get a toast
  explaining the reset, and stale prior-season standings are cleared
  instead of flashing on the rank screen.

### Changed
- LICENSE is the canonical Apache-2.0 text; upstream attribution moved
  to a NOTICE file (Apache section 4(d)), and the published image now
  carries both.

## [1.2.0] - 2026-07-16

### Added
- "How cour works" in the account menu reopens the first-run tutorial
  on demand.

## [1.1.2] - 2026-07-16

### Fixed
- Browsers that dismissed the mistimed 1.1.0 tutorial never got the
  properly-timed one: the dismissal had already stored the seen-flag.
  The flag key is bumped so every such browser gets one correct showing
  on its next room join.

## [1.1.1] - 2026-07-16

### Fixed
- The first-run tutorial now appears when you first land in a room,
  instead of popping up over the join form while the login/join round
  trips were still in flight (it read as showing up "before logging
  in"). Fresh joins only -- a mid-session reconnect can't interrupt
  with it.

## [1.1.0] - 2026-07-16

The audit-17 release: a full adversarial audit of 1.0.0 (26 findings
fixed across five waves), the season-rotation lifecycle, and a first
batch of post-1.0 UX features.

### Added
- **Season rotation (the owner's spec).** The served season rotates
  automatically one month before the calendar changeover (Dec/Mar/Jun/
  Sep 1). The show list refreshes daily during the pre-season window and
  freezes two weeks before the season starts. Rooms and their members
  are deleted at rotation (the rotation reaper) -- until then everything
  stays saved; a reused room name simply creates fresh. The config frame
  carries the served season/year, so the UI themes and labels from the
  server, never the browser clock.
- **First-login tutorial**: a one-page explainer (verdicts, hold-Unsure
  skip-all, review-before-lock, lock-then-rank) shown once per browser.
- **Room pulse**: the review screen shows "N OF M LOCKED" live, and the
  everyone's-locked celebration now reaches every member, exactly once.
- **Standings upgrades**: rows name who ranked each title, open the
  read-only details drawer (synopsis/PV/screenshots post-lock), and the
  headline reads "ALL N RANKINGS IN - FINAL" or "WAITING ON <names>".
- **"My review" after lock-in**: the ledger stays reachable as a
  read-only peek from the account menu, with a way back to standings.
- **Share-room dialog**: a select-on-focus link field replaces the
  vanishing toast on plain-HTTP LAN (no clipboard API there).
- Next-poster prefetch: card advances land inside the crossfade.
- A user-row cap (2000) backstops the unauthenticated login path.

### Fixed
- A remotely triggerable process crash in the WebSocket upgrade path
  (no error listener on the raw socket during the handshake window).
- Lock-in is validated server-side: completeness against the CURRENT
  deck, idempotent re-locks, and no premature all-locked when a joined
  member hasn't verdicted yet. The review ledger and rankings are scoped
  to the current deck, so removed titles can't wedge the lock button,
  overshoot the progress count, or seed poster-less standings rows.
- Reconnects no longer wipe room state or teleport users to the deck;
  reloads land by ledger state (mid-pass resumes the deck, finished and
  locked users land on their real screen with honest copy).
- The deck holds behind the ledger, so a stale first card can never
  silently overwrite verdicts from an earlier session; failed review
  fetches retry.
- Keyboard verdicts ignore OS key auto-repeat; two-finger presses on
  Unsure can't fire a surprise skip-all; verdict controls disable while
  disconnected instead of losing taps to the rejoin window.
- The results request rides the request/timeout helper and the rank
  screen gates on it -- submitted users can no longer lose edits to a
  phantom editor.
- A schema-version guard refuses databases written by a newer build
  instead of silently stamping them down; the season cache fsyncs before
  its rename; skip-all writes in one transaction.
- One null AniList entry no longer kills the season fetch; retry
  failures report the real error instead of a stale 429; missing posters
  are 404, not 502; the auth throttle never evicts an actively
  locked-out IP.
- A failed room restore can no longer NULL saved filters; mid-join
  socket death can no longer install a ghost member that holds a name
  hostage; concurrent first logins of the same new name recover instead
  of hanging the loser.
- Mobile: long titles clamp instead of climbing over the top bar; toasts
  wrap long links; synopses keep their paragraph breaks; avatar initials
  survive emoji and kanji names.
- Accessibility: toasts announce via aria-live and dismiss on click;
  the lock-in and submit dialogs take focus, close on Escape and
  backdrop click.

### Changed
- The Unraid template is cour's own (right image, port 8000, honest
  overview and env vars) instead of the pre-pivot reely/Plex one;
  .env.example and config.example.yaml document what the app actually
  reads; the reverse-proxy doc's HAProxy/Apache examples work as pasted
  and explain the shared-IP throttle tradeoff.
- package.json license corrected to Apache-2.0 (matching LICENSE).
- CI workflows run least-privilege and pin third-party actions by
  commit SHA.
- docs/SCOPE.md rewritten as a current-state document.

### Removed
- The filter panel and the whole user-facing filter vocabulary (wire
  messages, server handlers, UI). cour deals the whole season: simple.
  Legacy room filters stay honored until the rotation reaper clears
  them.
- The half-alive i18n pipeline (six locale files localizing one string
  in an unmounted component); every live string is English in source.
- Dead surface across the codebase: the deckState wire flow, five
  provider methods, credential-era store accessors, and the stale
  comments that described them.

## [1.0.0] - 2026-07-07

First stable release.

cour is a seasonal anime picker: create or join a room, work through the
season's catalog with Keep / Pass / Unsure verdicts, lock in, and see
where your picks agree. Built on the room/verdict engine forked from
reely, with an AniList-backed seasonal catalog and a considered desktop
treatment across every screen. 1.0.0 promotes the 0.16.x line to stable
with no functional change from 0.16.1.

## [0.16.1] - 2026-07-07

### Added
- The app version shows as a quiet mono footer at the bottom of the
  account menu (reads the version injected into the HTML shell).

## [0.16.0] - 2026-07-07

### Changed
- **Verdict terminology: Keep / Pass / Unsure** (was Like / Dislike /
  Skip). Neutral language over the emotionally-loaded originals; the
  middle ground ("Unsure") stays -- it keeps the sorted piles
  manageable. Piles and ledger pills use the state form (Kept / Passed
  / Unsure); desktop keyboard shortcuts remap to K / P / U. Internal
  verdict values, scoring, the SQLite store, and the wire are all
  unchanged -- a pure relabel.

### Added
- **Account-menu navigation** (while in a room): "Keep going -- N left"
  jumps straight to the next unrated title when the deck is unfinished;
  "See your review" opens the ledger from the deck (even mid-deck);
  "Share room" copies a ?roomName join link (the invitee still types
  their own name) with a clipboard fallback on insecure contexts.
  Redundant entries hide on the current screen; keep-going and review
  both hide once locked in.

## [0.15.1] - 2026-07-07

### Fixed
- Desktop keyboard hint now reads in button-row order -- **D / S / L**
  (dislike, skip, like) instead of L / S / D. The shortcut keys are
  unchanged; only the hint's display order flipped to match the row.

## [0.15.0] - 2026-07-07

Desktop, the rest of the app (docs/DESKTOP.md extension). The 0.14.0
pass did the deck; this brings the considered treatment to every
remaining screen. Below 900px nothing changes.

### Added
- **Shared AppHeader** (desktop): brand + season kanji + room label
  left, account popover right, optional leading slot (the deck's
  progress chip / scope-back). Replaces the three ad-hoc desktop
  headers the deck/review/rank screens each grew.
- **Review -> rail + main.** Sticky left rail holds the status and the
  lock-in action (out of the sticky footer, always visible); the pile
  tabs + ledger get a wider column. Mobile keeps the single stack.
- **Rank editor -> rail + main + drag-to-reorder.** Left rail: the
  headline, a proper 12/9/6/3/1 point legend, and the submit button.
  Pointer drag reorders the list (grab any row; the up/down buttons
  stay as the keyboard + touch path).
- **Rank standings -> elevated list** (the owner's call over a podium, to
  keep the guide's quiet voice). #1 is a poster-forward accent hero
  row; ranks 1-3 carry medal color; a light fade cues a live update
  (reduced-motion respected).
- **Join -> centered card.** The form becomes a bg-1 card over the
  kanji watermark, inputs recessed to bg-0 for contrast.
- Loading wordmark left as-is (already responsive via clamp).
- **"Everyone's #1"** on the standings: each submitted member's top
  pick (rank 1) shown with their name, regardless of where it lands in
  the combined order (a first step toward who-picked-what). New wire
  field topPicks on the results payload.

### Changed (the owner's review pass)
- Desktop screens are fixed-height shells: the header, rails, pile
  tabs, and actions stay put; only the list scrolls.
- Review ledger shows every row on desktop -- no "+N MORE" truncation
  (the list scrolls instead).
- Standings show the top 5 by default with a reveal for the rest.
- Rank drag-to-reorder no longer selects page text mid-drag.
- Dev-only escape hatch: `PWA_KILL=1` ships a self-destroying service
  worker (clears a stale precache during rapid UI iteration). Default
  off, so normal builds ship the real offline PWA.

### Fixed (mobile, the owner's live-testing pass)
- **Deck card transition reworked into a true dissolve.** The previous
  crossfade faded the incoming poster in while the outgoing faded out,
  so the midpoint dipped dark and read as a flash. Now the next card is
  simply present and only the outgoing card dissolves over it (ease-out
  ~460ms, slight scale), with a soft verdict-colored glow rising from
  the button side rather than a full-bleed color pulse. Skip stays a
  plain crossfade.
- **The verdict row no longer floats to mid-screen while dragging the
  drawer.** Root cause: the sliding panel's `translateY` pushes its box
  below the sheet container, which under `overflow: hidden` becomes
  scrollable overflow; a touch-drag scrolled that and carried the
  absolutely-positioned verdict row up with it. The container now uses
  `overflow: clip` (clips identically, but is not a scroll container),
  the verdict row is pinned out of the panel's flow, and its measured
  height is reserved by the panel via a CSS var. The row stays welded
  to the bottom through any drag. The open/close settle also lost its
  spring overshoot (a plain ease-out) so the panel no longer bounces.

## [0.14.0] - 2026-07-07

Desktop polish (docs/DESKTOP.md). The mobile-only constraint lifts;
below 900px nothing changes.

### Added
- **Desktop deck stage** (>= 900px): a two-pane layout instead of the
  full-bleed poster + bottom sheet -- poster card on the left (2:3,
  the guide's poster shadow, the card-exit crossfade + verdict wash
  move with it), the details (media box, thumb strip, synopsis, links)
  and verdict row always visible on the right. No sheet: progressive
  disclosure is a small-screen compromise, not a virtue to keep. The
  reference is the Steam store page, already the media box's design
  ancestor.
- **Keyboard verdicts** (desktop): L = Like, S = Skip, D = Dislike,
  ignored while an input has focus or a modifier is held. A quiet mono
  hint sits under the verdict row. Rationale: the guide's "buttons,
  not gestures, decide" is about explicit commitment -- a deliberate
  keypress is a button in spirit.
- **Ledger columns**: Review and Rank cap at a 680px centered column
  on desktop (Letterboxd/AniList list proportions); row hover lifts on
  pointer devices.

### Changed
- **DeckDetails extracted** from DeckSheet: the full PV state machine
  (one-shot autoplay, blocked-autoplay fallback, command-channel
  unmute, ended/error signals) now lives in one component the sheet
  mounts on mobile and the desktop stage mounts directly. Pure
  refactor -- behavior frozen by the DeckSheet suite. Fixed a latch
  bug the split exposed: the per-card ref reset ran on mount and
  clobbered the "one autoplay per card" latch (masked on mobile
  because the sheet mounted while closed).

## [0.13.2] - 2026-07-07

Deploy-prep cleanup (the owner's review of the Unraid template) + verdict
flair.

### Added
- **Verdict transitions**: the outgoing card no longer blinks away --
  it stays for a beat, fading and settling down (the style guide's
  exit, finally built) while the next card fades in beneath, with a
  brief wash in the verdict's color over the exiting poster: accent
  for Like, clay for Dislike, nothing for Skip (a shrug, not an
  event). Verdict buttons compress slightly under the finger. Plain
  fades under prefers-reduced-motion.

### Changed
- **AniList is the built-in default server**: zero configuration boots
  a working app. The PROVIDER env var and YAML server entries remain
  as overrides in shape only; there is exactly one provider, so
  nothing asks. The unconfigured screen is effectively unreachable.
- docker-compose.yml drops the PROVIDER line accordingly.
- SQLite's bare "unable to open database file" on boot now explains
  itself: the data volume isn't writable by the container's node user
  (uid 1000) -- exactly what a fresh Unraid appdata dir looks like
  (found deploying to the Unraid host; fix is chmod/chown on the host dir).

### Notes
- HTTP Basic Auth (AUTH_USER/AUTH_PASS) is NOT the removed account
  system -- it's the perimeter gate in front of the whole app for
  non-LAN exposure, and deliberately survives the 0.12.0 teardown.

## [0.13.1] - 2026-07-06

### Added
- **The style guide v1 is versioned in-repo** (docs/branding/): the
  authoritative design reference, plus the mark and auth-background
  addendum specs. reely's logo assets retired. Token audit against the
  guide: zero drift (surfaces, text ramp, lines, clay, all four
  accents + hi/soft derivations match exactly).
- Motion polish per the guide's section 07: card advance (next poster
  fades in with a slight settle; plain fade under reduced motion),
  media-box tile crossfade (~240ms), drawer spring retuned to ~320ms.
- **The app has a face**: the "Dotted answer" mark (design addendum
  APP_MARK.md) -- the ivory arc is the c, the answer comes back as four
  dots, the four seasons, so the mark belongs to no single cour even as
  the in-app accent rotates. Shipped everywhere: PWA icons (any +
  maskable, 512/192), apple-touch 180, favicon (the small two-arc
  variant per the addendum's size rules -- dots don't survive 32px),
  canonical icon.svg, and the join screen's **stylized wordmark** --
  the mark IS the c, per the style guide's construction (0.9x cap
  height, heavier r=5 dots as the c's counter, 2px gap; the owner's idea,
  formalized by design the same day). reely's card-stack icons are
  gone.

## [0.13.0] - 2026-07-06

Ranking IS the scoring: the post-lock results flow, straight from the
couple profile's manual method.

### Added
- **The rank screen**: lock-in now lands you on it automatically. You
  order your LIKED titles (up/down controls, position numbers, the top
  five slots showing their point values); dislikes and skips are
  discarded and never score. Submit rankings sits behind a "no turning
  back." checkbox dialog -- one shot, no resubmits.
- **Combined standings**: the couple-profile point table (#1=12 #2=9
  #3=6 #4=3 #5=1 per submitter, deeper ranks recorded but scoreless),
  summed across everyone who has submitted; ties break by the better
  single best rank, then titleId (the profile's coin flip, made
  deterministic). Shows "N OF M RANKINGS IN" and **updates live**: the
  server pushes fresh standings to every connected room member the
  moment anyone submits.
- Wire: `submitRankings` (validated as an exact permutation of your
  likes) / `results` + `resultsSuccess` (also the live push). Schema
  v5: `rankings` table + a one-shot submitted stamp per member.

### Removed
- **The +1/0/-1 tally**: with dislikes and skips discarded from
  scoring, the lock-time computation had nothing left to say. The
  room_results table is dropped in the v5 migration; standings compute
  on demand from rankings.

### Changed
- Lock-in copy points at what's next: "Next you'll rank your likes --
  that's what scores the season." The all-locked toast says the same.

## [0.12.0] - 2026-07-06

Back to basics (the owner's call): the credential layer is gone. cour works
like reely again -- a name and a room -- but keeps SQLite persistence,
so verdicts, locks, and results survive restarts and span the season.

### Removed
- **Passwords, sessions, roles, and the entire admin surface**: the
  login/setup screens, change-password, the admin panel with user and
  room management (added in 0.11.0 and removed the same night --
  the recommendation-engine framing that justified durable personal
  accounts was dropped, and for a friends-and-LAN app the credential
  protected nothing a friend group needed). scrypt/auth module,
  sessions table (schema v4 drops it in place), all admin* and auth*
  wire messages, the runtime settings store and dialog.
- The reconnect rejoin window: rooms are permanent and membership
  durable, so every login simply rejoins the remembered room.

### Added
- **The join form**: your name + room name, both remembered, ?roomName
  deep links honored. `login { userName }` claims (and on first sight
  creates) the persistent user row -- case-insensitive, so the same name in any casing maps to
  the same person across devices.
- **Lock-in confirmation**: lock-in is FINAL now (no admin unlock
  exists), so the button opens a "no take-backsies." dialog that
  requires an explicit checkbox before the lock button arms.
- **Scheduled season refresh**: the AniList snapshot re-fetches
  automatically two weeks before the season ends (daily check, keyed
  to the cache timestamp so restarts don't re-trigger). The manual
  refresh button died with the admin panel.
- `TMDB_API_KEY` env var / `anime.tmdbApiKey` config (redacted in
  logs): the key is static deploy config now. docker-compose.yml
  finally modernized from its reely-era Plex shape.

### Changed
- Autoplay-PVs-with-sound is a localStorage preference (it was a
  server-side account column).
- The account popover slims to name + autoplay + Leave room.
- Home renders the review when in a room, the join form otherwise --
  the join form IS the login now.

## [0.11.0] - 2026-07-06

Room + user management, and the account popover.

### Added
- **Admin panel** (new screen off the account menu): hosts Manage
  rooms, Manage users, the AniList season refresh, and the TMDB key
  dialog (all relocated from the old account sheet).
- **Manage users**: list accounts, invite (admin sets the initial
  password, 8+ chars), reset any password inline, delete with a
  two-tap confirm. Your own row is marked and undeletable (the server
  refuses self-deletion regardless).
- **Manage rooms**: every room with season, member count, lock tally,
  and results state; expand for per-member verdict counts. Per-member
  **UNLOCK** (undoes a lock-in and drops the stale tally -- it
  recomputes when everyone locks again), **RESET ROOM** (verdicts,
  locks, positions, results wiped), **DELETE ROOM** (row + cascades +
  the live WS instance), and create. Destructive actions are two-tap.
- New wire: adminListRooms / adminDeleteRoom / adminUnlockMember /
  adminResetRoom (+ store accessors). Admin mutations re-fetch the
  management lists; an unlock/reset hitting YOUR current room also
  refreshes the review ledger live.

### Changed
- **The account sheet became a popover** (the owner's call): a speech
  bubble hanging off the avatar with just the essentials -- autoplay
  toggle, change password (inline), log out -- plus the Admin panel
  entry for admins. Outside tap and Esc dismiss it.

## [0.10.0] - 2026-07-05

Re-review passes: change your mind before locking in.

### Added
- **Tap any row on the review page** to reopen that title as a full
  deck card (poster, sheet, PV, the works). Verdicting it -- or
  backing out -- lands straight back on the review page; it never
  drops into the season flow.
- **REVIEW ALL N <PILE>**: cycle just that pile (liked, disliked, or
  skipped) as its own pass, in row order, with a position chip and a
  back control. The list is snapshotted at entry, so re-verdicting
  mid-pass doesn't reshuffle what's left; the last verdict returns to
  the review page.
- Scoped passes disable hold-to-skip-all ("skip the rest of the
  season" has no business inside a pile pass); plain Skip still works.
  All client-side: re-verdicts ride the existing verdict UPSERT.
- **The original choice is haloed** during a re-review pass: the
  verdict button matching the existing verdict carries a ring + glow
  in its own color family (and announces "your current pick" to
  screen readers), so what you're changing FROM is visible at the
  moment of re-deciding.

### Changed
- Post-lock, review rows lose their navigation along with their pills
  (the server refuses verdict changes anyway).

## [0.9.1] - 2026-07-05

First live-test fixes (Firefox/Android).

### Fixed
- **Every PV embed showed a YouTube error**: helmet's default
  `Referrer-Policy: no-referrer` strips the referrer YouTube requires
  for embedded playback. Now `strict-origin-when-cross-origin` (the
  browser default).
- **Saving a TMDB key changed nothing on screen**: enrichment ran fine
  server-side but rooms that were already open kept their stale media
  payload. The provider now signals the app layer after enrichment and
  refreshed media is pushed to every open room (a silent
  filterChangeApplied -- no toast).
- **The lip only opened by tap**: swipe-up on the deck's sheet lip now
  opens the drawer (24px of upward pointer travel; the verdict row is
  excluded), and the drawer's grabber zone closes on drag-down.
  `touch-action: none` on both zones so Firefox/Android delivers the
  pointer events instead of claiming the gesture as scroll.
- **Login screen unreadable**: reely's leftover pink/amber glow blobs
  (30%/24% opacity in the shared Layout) died, per the AUTH_BACKGROUND
  design addendum -- "deleted, not layered under".
- **Returning shows got no stills**: the TMDB search pinned
  first_air_date_year to the current season, but TMDB indexes a series
  by its FIRST air date -- a 2024 show airing a sequel cour never
  matched (found via Smoking Behind the Supermarket with You). A miss
  now retries without the year.
- **The drawer became a real bottom sheet** (second + third live
  passes): the verdict row is static chrome floating at the bottom of
  the deck; the grabber + "Synopsis / PV / Links" strip is the TOP
  EDGE of the panel and leads it up, tracking the finger 1:1 during
  the drag. Release past 25% of the travel commits open/close, less
  springs back; tap, Enter, Esc, and the dim scrim still work. A
  closed sheet unmounts the PV, so audio can never outlive it.
- **Steam-style media rotation**: the PV is part of the 3s cycle like
  any other tile, but while the video tile is up the rotation holds --
  however it got there -- and resumes when the player reports the
  video ended (IFrame-API postMessage handshake on the embed, no
  YouTube script; the handshake sends the addEventListener command and
  accepts both onStateChange and infoDelivery playerState shapes).
  Every image tile -- rotation-served or tapped -- holds 7 seconds
  behind a slim accent progress bar along the media box's bottom edge,
  then advances (tapping restarts the clock). The video gets ONE
  automatic play per card when the autoplay setting is on (parking the
  rotation until it ends); with the setting off, or on later passes,
  it's a passive tile -- no autoplay, bar counting, and a tap on the
  player (any setting) plays with audio, dismisses the bar, and parks
  the rotation. Pausing hands it back. The player double-reports
  ended (both message shapes); a latch keeps the advance single so
  the image after the video doesn't get skipped. Player errors
  (deleted video, embedding disabled -- onError codes via the same
  channel) swap the embed for a watch-directly-on-YouTube card that
  rides the normal 7s rotation instead of parking it.
- **TAP FOR SOUND no longer restarts the video**: unmuting used to
  swap the embed URL, which reloads the player from zero. It now sends
  unMute/setVolume over the IFrame-API command channel -- the video
  keeps playing from where it was.
- **Autoplay-with-sound after a reload**: browsers block unmuted
  autoplay until the user has engaged with the page, so the first PV
  after a reload sat unstarted. An unmuted embed that doesn't report
  playing within 2.5s now falls back to muted autoplay with the TAP
  FOR SOUND chip -- the video always starts, sound is one fresh-gesture
  tap away.
- **Screens uncapped from the interim 480px column**: the deck and
  review now fill the device width; the auth forms keep their inner
  column inside a fluid screen. Desktop-proper layouts remain a design
  round-trip.

### Added
- **TMDB key feedback**: saving a key probes TMDB server-side and the
  toast reports "saved and verified" or "rejected -- check the key";
  the account sheet's TMDB row now shows a KEY SET / NO KEY status.
- **"Kanji watermark" auth background** (design addendum, adopted frame
  Auth BG C): a huge season kanji in Shippori Mincho bleeding off the
  top-right at 7% accent tint over an 8% accent bloom, on flat bg-0.
  Built with color-mix over the accent custom property so it rotates
  with the cour automatically. Auth/first-run screens only, per the
  addendum's scope rule.

### Changed
- Global sound is gone for now (the owner's call): the deck's top-bar mute
  button is removed and the account sheet row is now "Autoplay PVs
  with sound" -- the same account-level soundPref, scoped to what it
  actually did (whether drawer PVs start unmuted).

## [0.9.0] - 2026-07-05

TMDB stills -- the last scoped phase of the cour pivot. The details
drawer's thumbnail strip fills with real screenshots once a TMDB API key
is saved in Settings.

### Added
- `internal/app/tmdb`: minimal TMDB client (v3 key or v4 bearer token,
  auto-detected) -- title+year search against the TV or movie index per
  the AniList format, backdrops capped at six per title. Deliberately
  modest matching: a wrong match costs a wrong screenshot row, nothing
  else.
- Background enrichment: runs after the season snapshot loads or
  refreshes AND immediately when a key is first saved (no restart);
  sequential with a polite pause; per-title failures are debug noise,
  not errors; results persist into the season cache (v3) with the
  resolved tmdbId so refreshes never re-search. Enrichment survives
  catalog refreshes (stills carry across by id).
- `Media.screenshotUrls`: proxied same-origin /api/poster paths --
  thumbId 0 stays the cover, >= 1 indexes the entry's stills. The
  artwork proxy's host allowlist gains image.tmdb.org; CSP img-src
  stays 'self'.
- Drawer strip: still tiles append after PV + hero as a flat
  horizontally-scrolling list (no overflow stacking -- the owner's call),
  capped at one video + ten images; the active thumb scrolls into
  view as the rotation walks the line (selection ring drawn inside
  the thumb so the scroller can't clip it). The synopsis renders
  fully expanded -- the panel as a whole scrolls, one behavior for
  every screen size.

### Notes
- Live TMDB verification is pending the API key -- the no-key path
  (enrichment silently absent, drawer unchanged) is what ships
  verified today.

## [0.8.0] - 2026-07-05

The seasonal review screen (design section 07) -- the post-login landing.

### Added
- **Review screen**: "your <season> review" header with room context
  line and the 4px accent progress bar; resume banner (poster thumb,
  titles-left count, next title, straight back into the deck); pile
  tabs (Liked/Disliked/Skipped with counts, active accent-soft +
  accent border); verdict ledger rows (40x56 thumbs, mono meta,
  **tap-to-change verdict pills** cycling like -> dislike -> skip via
  the normal UPSERT -- where skips get re-targeted and mistaps get
  fixed); "+N MORE" overflow reveal; pinned lock bar (disabled with a
  countdown until the ledger is complete, accent when live, "Locked
  in" after; caption per the design). Post-lock the pills disable.
- **Login-time auto-rejoin**: `room_members` gains a `joined_at`
  recency stamp (schema v3 -- the first in-place ALTER migration for
  existing databases), `lastRoom` rides the authLogin/resume success
  payloads, and the client rejoins it so the review IS the landing.
  A ?roomName deep link still outranks it.
- `lockIn` wired end to end: complete-ledger button -> reducer marks
  the ledger locked; the all-locked edge surfaces as a toast (the
  results screen remains undesigned -- the tally is stored).
- Deck's exhausted state now routes into the review.

### Changed
- The home route renders the review whenever a room is joined; the
  interim join form survives only as the no-room fallback until the
  room create/join design exists.

## [0.7.0] - 2026-07-05

The deck + details drawer (design section 03 + section 04's skip-states
card) -- cour's core screen. The interim room screen retires.

### Added
- **The deck**: full-bleed cover art with the design's scrim, top bar
  (progress chip = verdicts/total, room label + wordmark + season kanji,
  sound toggle, avatar), info block (genre chips capped at 3, Shippori
  40px title, romaji secondary line, mono meta line -- no ratings
  anywhere), and the collapsed sheet lip. Verdict buttons advance the
  deck; no swipe gestures by design. Current card = first title in the
  popularity order without a verdict.
- **Verdict row** (shared by lip + drawer): clay Dislike pill, text-only
  Skip with **press-and-hold-to-skip-all** (1.5s accent-soft sweep;
  early release = single skip; keyboard path is always single-skip),
  solid accent Like pill.
- **Details drawer**: dimmed deck behind, 16:9 media box -- PV leads
  muted via a youtube-nocookie embed with a TAP FOR SOUND chip (account
  soundPref ON starts unmuted), hero art fallback so there is never a
  dead player -- thumbnail strip with 3s auto-advance and tap-to-pin
  (data-driven; TMDB stills slot in at 0.9.0), internally-scrolling
  synopsis with bottom fade, AniList/MAL pills, pinned verdict row.
- **`skipRemaining` wire message**: hold-to-skip-all is one server call
  (a per-title storm would eat the 100/10s WS rate limit). Refused
  after lock-in like any verdict write.
- Deck meta data on the wire: `titleRomaji`, `format`, `episodes`,
  `studio` (AniList query now selects main studios). The season cache
  tolerates older versions -- serving a stale-format snapshot beats
  refusing to boot during an AniList outage (the API was down while
  this shipped).
- Review ledger fetched on room join; deck position persisted
  fire-and-forget after every verdict; ledger re-fetched after
  skip-all. CSP gains `frame-src https://www.youtube-nocookie.com`.

### Removed
- The interim room screen (0.4.0's placeholder).

## [0.6.0] - 2026-07-05

The auth screens (design section 06) -- cour's first designed UI, and the
end of the reely-era anonymous login.

### Added
- **Sign-in screen** per the handoff: bottom-weighted form, season label,
  stay-signed-in toggle (default ON; OFF keeps the session token
  in-memory only), password visibility toggle, invite-only footer.
- **First-run setup screen** (owner-directed addition, login-form
  grammar): shown while the users table is empty; creates the admin with
  a confirm-password field (a typo'd admin password has no reset path)
  and auto-signs in.
- **Account sheet** (avatar tap, bottom sheet): sound & theme music
  toggle (persists via soundPref), my-review row (placeholder until
  0.8.0), inline **change password** form, log out; admins additionally
  get the ADMIN block -- Manage rooms/users as inert entries, a live
  "Season data - refresh from AniList" action, and the TMDB key dialog
  (relocated from the old login-screen gear).
- **Home screen** (interim landing): join-room form + account sheet
  entry point; replaced by the seasonal review screen in 0.8.0.
- Session lifecycle in the browser: token persisted per the
  stay-signed-in choice, `resume` on connect (never preempting an active
  auth form), silent room rejoin after quick reconnects, token rotation
  on password change, full clear on logout.

### Removed
- **The anonymous login, entirely**: `login`/`logout` wire messages,
  server handlers, the localStorage userName session, and the old
  login screen's name-chip/room-name form (room joining moved to Home).

### Changed
- Room-flow errors (join/create) now land on the home screen.
- `leaveRoom` navigates to home instead of the login screen.

## [0.5.0] - 2026-07-05

The protocol pivot (`docs/SCOPE.md`): the verdict era's wire vocabulary
and storage wiring. Server capability only -- no screen consumes any of
this until 0.6.0+; the anonymous login and interim room screen still run
the show in a browser.

### Added
- **Credentialed auth over the wire**: `setup` (first-run admin creation,
  valid only while the users table is empty; the config frame advertises
  `needsSetup`), `authLogin` (uniform invalid-credentials error, no
  username oracle), `resume` (token), `authLogout`, `changePassword`
  (verifies the current password, revokes every session, returns a fresh
  token so the current device stays signed in). A credentialed identity
  also assumes the anonymous one, so every room flow works unchanged.
- **Verdicts**: `verdict {titleId, verdict}` (idempotent UPSERT, title
  must be in the room's deck, refused after lock-in), `review` (ledger +
  counts + deck position + lock state + deck total), `lockIn` -- when the
  LAST member locks, the server tallies Like +1 / Skip 0 / Dislike -1
  per title and stores ranked results in `room_results` (new table;
  surfacing waits on the results design). `deckState` and `soundPref`
  persist fire-and-forget.
- **Admin surface** (role-gated): create/list/delete users (self-deletion
  refused so the instance stays administrable), set passwords,
  `adminCreateRoom` (the interim room-creation path -- writes the SQLite
  row; the join path materializes the deck), `adminRefreshSeason` (new
  optional `refresh()` on the provider interface, wired on anilist).
- 60 new tests across the store extensions and the handler surface.

### Changed
- **Room persistence moved from JSON files to SQLite.** Legacy
  `data/rooms/*.json` files import one-way on first load (renamed to
  `.imported`). The save-debounce machinery and the uncaught-exception
  flush watchdog died with the JSON write path.
- Stale reely/plex strings in `cmd/reely/main.ts` (version banner,
  unconfigured-mode hint) now say cour/anilist.

## [0.4.0] - 2026-07-05

The teardown + data layer phase of the cour pivot (`docs/SCOPE.md`). The
swipe era ends here; the verdict era's foundation goes in.

### Removed
- **Swiping**: CardStack, card gestures, keyboard-arrow rating,
  react-spring dependency, the per-room deck shuffle, the `rate` wire
  message and its entire defense stack (offline queue, dedup sets,
  flush-on-rejoin).
- **Real-time matching**: matches, MatchMoment, MatchesList, match
  broadcasting, per-user progress tracking and pills, UsersPopup,
  `previousMatches` on the join payload.
- **The plex provider** and everything plex-shaped: internal/app/plex,
  PlexLinks + reachability probe, `plexServerId`/`plexBaseUrl`/
  `EXPOSE_PLEX_BASE_URL`, server `token`/`libraryTitleFilter` config,
  PLEX_* env vars, Google Fonts CSP allowances. cour is anime-only;
  `Media.type` and `ProviderType` narrowed accordingly.
- **Room expiration**: the 6h TTL sweep, `lastSwipeAt`, and the login
  footer's expiry copy. A cour room lives until explicitly deleted.
- The reely Logo atom (Wordmark everywhere now) and legacy color aliases.

### Added
- **SQLite data layer** (`internal/app/cour/`, via node:sqlite -- no
  native dependency): full schema (users, sessions, rooms, room_members,
  verdicts; rooms deliberately have no expiry column) plus user + session
  accessors. scrypt password hashing (16384/8/1, salted,
  parameter-versioned storage format), 8-character password policy,
  session tokens stored only as SHA-256 hashes, stay-signed-in vs short
  TTLs, change-password revokes all sessions. Nothing is wired into the
  live WS flow yet -- the credentialed login arrives with 0.5.0/0.6.0,
  and an empty users table is a valid state until the first-run setup
  screen (0.6.0) creates the admin.
- Interim room screen: room name, member list, share link, leave.
  Deliberately plain transitional scaffolding -- the cour deck (design
  section 03) replaces it in 0.7.0.

### Changed
- `JoinRoomSuccess.users` is a plain `User[]`; `userJoinedRoom`/
  `userLeftRoom` carry a bare `User`. Anonymous login remains functional
  until the protocol pivot.

## [0.3.0] - 2026-07-05

The identity phase of the cour pivot (`docs/SCOPE.md`). The product is now
**cour**; interaction changes (verdicts, accounts, teardown of
swiping/matching) come in the following phases -- the old screens still
run in this release, recolored.

### Added
- `docs/SCOPE.md`: scope of record for the reely -> cour pivot.
- Direction B "Seasonal print" design tokens (oklch) with a seasonal
  accent that rotates per broadcast quarter (sakura / indigo / persimmon /
  ice) plus the season kanji; applied before first paint by
  `utils/season.ts`.
- Self-hosted webfonts (~189 KB total, precached by the PWA): Geist,
  Geist Mono, and Shippori Mincho (Latin subsets + the four JP slices
  carrying 春夏秋冬). Google Fonts CDN dependency removed entirely.
- `Wordmark` atom: set-type "cour" + current-season kanji chip. Replaces
  the reely logo on the Login screen.
- Runtime settings store + Settings dialog (TMDB API key entry; key never
  echoed back to clients), AniList/MAL links replacing "Open in Plex" for
  anime media, and the honest `Media.type: "anime"` narrowing -- built
  pre-pivot, first released here.
- `config.example.yaml`.

### Changed
- **Renamed everywhere user-visible**: package `cour` / `cour-ui`, web
  manifest, page title, Loading/Config screens, health body ("cour is
  alive"), README rewritten. GitHub repo renamed to `cajunflavoredbob/cour`.
- Token prefix `--ry-*` -> `--cour-*` across the web app; the reely
  pink-amber gradient is retired (all former gradient surfaces now use
  the seasonal accent). Legacy color aliases repointed at the new palette
  pending the 0.4.0 teardown.

## [0.2.1] - 2026-07-05

### Changed
- Consolidated the repo's first Dependabot drop (PRs #1, #3-#6, closed in
  favor of this commit): actions/checkout 6 -> 7, zustand 5.0.14, dev group
  (Biome 2.5.2, tsx 4.23.0, vitest 4.1.9), vite 8.1.3, js-yaml 5.2.1.
  The two failing majors were closed without merging: node 26 base image
  (Dockerfile deliberately pins the Node 24 LTS line) and React 19
  (fails the suite; revisit as its own migration batch).
- `biome.json` migrated to the 2.5.2 schema (`preset: "recommended"`);
  `static/icons/` excluded from linting (Biome 2.5 started linting raw
  SVG assets and wants `<title>` on a PWA icon file).

### Fixed
- Two audit-16 #440 sanitizer test rows meant to cover "backslash between
  dots" were mistyped as `'.\.'`, which is just `'..'` at runtime -- the
  separator-between-dots case was silently untested. Now `'.\\.'` as
  `stripDangerous`'s own comment describes. (Surfaced by Biome 2.5.2's
  `noUselessEscapeInString`.)

## [0.2.0] - 2026-07-05

### Added
- AniList seasonal provider (`PROVIDER=anilist` or YAML
  `servers: [{type: anilist}]`): the deck is the current broadcast season
  fetched from AniList's public GraphQL API, ordered by popularity (no
  per-room shuffle), with season/year auto-detected from the date and
  overridable via `ANIME_SEASON` / `ANIME_YEAR`.
- Sequel hiding: entries with a PREQUEL relation to another anime are
  excluded from the deck by default; `ANIME_SHOW_SEQUELS=true` includes
  them. Adult entries are always excluded (not configurable).
- Disk cache (`ANIME_CACHE_DIR`, default `data/anilist`): one JSON snapshot
  per season/year, served immediately at boot with a background refresh;
  first boot blocks on a live fetch. AniList being down after first boot
  no longer prevents startup.
- Genre and Format room filters computed from the seasonal snapshot
  (equality operators only), and cover art proxied through the existing
  poster route (host-allowlisted to `*.anilist.co`).
- Backend-only wire fields on media: `anilistId`, `malId`,
  `trailer {site,id}` -- captured for the upcoming AniList/MAL link and
  trailer rendering pass; nothing renders them yet.
- Providers can flag `mediaOrdered` to opt their deck out of the per-room
  shuffle; the Plex provider is unchanged.

### Changed
- `Config.servers[].token` is optional (anilist servers take none); the
  validator still requires it for plex servers.
- The WebSocket `config` frame withholds `plexServerId` / `plexBaseUrl`
  for non-plex providers so the browser never probes the AniList URL as a
  Plex server.
- `ProviderUnavailableError` message now leads with the provider type.

## [0.1.0] - Unreleased

### Changed
- Version reset to 0.1.0 for the fork; inherited CHANGELOG content removed.
- `docker-compose.yml` image pin reset alongside VERSION (image name is a
  placeholder until the branding pass names the project's own repository).

### Removed
- `.github/workflows/release.yaml`: it published to reely's Docker Hub
  repository on `v*` tags. A release pipeline returns once this project has
  its own image repository.
- `docs/CHANGELOG-archive.md` and `RELEASE_NOTES.markdown` history carried
  from reely.
