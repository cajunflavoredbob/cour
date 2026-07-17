# cour

Pick the season together.

**cour** is a self-hosted seasonal anime picker for a couple or a small
room of friends. Each broadcast quarter, everyone works through the new
season's lineup at their own pace -- **Keep / Pass / Unsure** on each
title -- then locks in. After locking, you rank the ones you kept, and
the room's rankings combine into a shared shortlist. Asynchronous by
design: no racing, no live matching, and you don't see anyone else's
picks until the rankings are in.

Season data comes from [AniList](https://anilist.co) -- titles,
synopses, cover art, trailers -- refreshed automatically at boot and
cached on disk. Sequels are hidden by default, since the point is
finding NEW shows.

- **Runs on AniList, no keys.** Titles, cover art, and trailers come
  from AniList out of the box. An optional TMDB key adds screenshots to
  the details view.
- **No accounts, no passwords.** Join with a name and a room name, both
  remembered on the device. State persists in SQLite across restarts,
  and rooms don't expire.
- **Phone and desktop.** An installable PWA on mobile, a two-pane layout
  on wider screens.

## Run it

A `docker-compose.yml` is included at the repo root:

```sh
docker compose up -d
```

Or directly:

```sh
docker run -d -p 8000:8000 -v cour_data:/app/data cajunflavoredbob/cour:latest
```

Open <http://localhost:8000>, enter a name and a room name, and share the
room name with whoever's picking with you.

### Configuration

Nothing is required to run. The one option in regular use is an optional
**TMDB API key**, which adds screenshots to the details view:

```
TMDB_API_KEY=<TMDB v3 key or v4 read token>
```

The server has other environment knobs -- pinning a specific season,
HTTP basic auth for exposing the app beyond your LAN, subpath hosting --
but they haven't been exercised on cour yet; check `.env.example` and
`config.example.yaml` before relying on them.

**Know the identity model before exposing cour beyond your LAN.** There
are no passwords: logging in is claiming a name, and anyone who can
reach the server can claim ANY name -- read that person's review,
change their verdicts, lock them in, or file their one-shot ranking.
That's the right trade for a couch full of friends and no gate at all
for strangers. If the port is reachable from outside your household,
turn on Basic Auth (`AUTH_USER`/`AUTH_PASS`) or keep it behind a VPN.

Behind a reverse proxy, forward the WebSocket upgrade (the app is
real-time over `/api/ws`); a persistent "disconnected" is almost always
the proxy dropping it. See
[`docs/reverse-proxy.markdown`](docs/reverse-proxy.markdown) for nginx,
HAProxy, and Apache examples, plus subpath and allowed-origin settings.

## Develop

```sh
pnpm install
cp .env.example .env   # defaults are fine; AniList needs no keys
pnpm serve             # builds the UI + server, runs on :8000
```

Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` before every commit;
CI runs the same three plus a multi-arch Docker build and an image scan.
See [CONTRIBUTING.markdown](CONTRIBUTING.markdown) for the project layout
and release process.

## License

Apache 2.0 -- see [LICENSE](LICENSE). Upstream attribution lives in [NOTICE](NOTICE).
