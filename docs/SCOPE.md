# cour - Scope (current state)

**cour**: a seasonal anime picker. Room members work through the season's
deck at their own pace, give each title a verdict (Keep / Pass / Unsure),
lock in, then rank their keeps; the room's combined standings decide what
the group watches. Async by design: no swiping, no real-time matching.
Design source of truth: the `design_handoff_cour/` bundle plus
`docs/DESKTOP.md` (Direction B "Seasonal print" tokens).

This document describes the product as SHIPPED at 1.0.x. The original
pivot plan (approved 2026-07-05) described a credentialed
scrypt/sessions/roles architecture that was built and then deliberately
removed in 0.12.0; this rewrite (audit 17, 2026-07-15) replaces that
historical plan so nobody reads dead architecture as current state.

## Identity

Passwordless, reely's model: logging in is claiming a name. The user ROW
in SQLite is the durable identity -- verdicts, locks, and rankings hang
off it and survive restarts -- but there is no credential. Anyone who can
reach the server can claim any name; HTTP Basic Auth
(`AUTH_USER`/`AUTH_PASS`) is the perimeter when the deployment is
reachable beyond the household (see the README's identity-model warning).
Names are 1-32 characters, unique case-insensitively.

## Rooms and the season lifecycle

- A room is a shared name (no password); joining a room that doesn't
  exist creates it. Room identity carries a display name and
  creation-time filters.
- The server serves ONE season at a time and rotates to the next season
  one month before it airs (Dec 1 / Mar 1 / Jun 1 / Sep 1). The show
  list refreshes daily during the pre-season window and freezes two
  weeks before the season starts, so nobody's deck shifts under them
  while they lock in.
- **Rooms and their members are deleted at rotation** (the rotation
  reaper). Until then everything stays saved. A reused room name simply
  creates fresh next season; user identities are global and survive.
- Pinning `ANIME_SEASON`/`ANIME_YEAR` disables rotation (testing only).

## The verdict flow

1. **Deck**: the season's titles, popularity-ordered, one card at a
   time. Keep / Pass / Unsure; hold Unsure to skip the rest. Sequels are
   hidden by default.
2. **Review**: the ledger in three piles, tap-to-change pills, re-review
   scopes back into the deck. Lock-in is final (checkbox-gated dialog)
   and requires a verdict on every title -- enforced server-side.
3. **Rank**: after lock-in, order your keeps; the top five score
   12/9/6/3/1 (the couple-profile method). One-shot submit; standings
   update live for everyone as rankings land.

## Storage

SQLite via `node:sqlite` at `data/cour.db`: `users`, `rooms`,
`room_members`, `verdicts`, `rankings`. The AniList season snapshot is
file-cached per (season, year) under `data/anilist/`. Schema version is
stamped forward only; a database from a newer build refuses to open.

## Protocol (WS)

`login`, `createRoom`/`joinRoom`/`joinOrCreateRoom`/`leaveRoom`,
`requestFilters`/`requestFilterValues`/`applyFilters`, `verdict`,
`review`, `skipRemaining`, `lockIn`, `submitRankings`, `results`. The
server pushes `filterChangeApplied` on any deck swap, `resultsSuccess`
to the room when a ranking lands, and a fresh `config` frame (which
carries the served season/year) after a season rotation.

## Deferred / not in scope

- Admin surface of any kind (removed 0.12.0; no plans).
- Per-room sequel/filter toggles beyond creation-time filters.
- Notifications, theme music, drawer screenshot gallery slot.
- The orphaned FilterPanel UI (server filters work; no mount point yet).

## Phase hygiene

Every change lands green (typecheck / lint / full suite / build) and
every push to main gets a version bump + CHANGELOG entry.
