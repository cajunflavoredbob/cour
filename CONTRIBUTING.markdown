# Contributing

## Prerequisites

- [Node.js](https://nodejs.org/) v24 or later
- [pnpm](https://pnpm.io/) v10 (`corepack enable`, or `npm install -g pnpm`)

No external services are required -- AniList is built in, so the app
boots with zero configuration.

## Getting started

```sh
git clone https://github.com/cajunflavoredbob/cour
cd cour
pnpm install
cp .env.example .env    # defaults are fine
pnpm serve              # builds the server + UI, runs on :8000
```

For frontend work with hot reload, run the backend and Vite in two
terminals:

```sh
# Terminal 1 -- backend (tsx watch)
pnpm dev

# Terminal 2 -- frontend dev server (proxies /api to :8000)
cd web/app && pnpm dev
```

Open <http://localhost:5173>.

## Project layout

```
.
├── cmd/reely/             # Server entry point
├── internal/app/
│   ├── anilist/           # AniList seasonal catalog client
│   ├── cour/              # Rooms, verdicts, rankings, SQLite store
│   ├── reely/             # Core server (WebSocket, config)
│   └── tmdb/              # Optional screenshot enrichment
├── types/reely.ts         # WebSocket protocol + shared types
├── web/app/               # Frontend (React 19, Vite, Zustand, CSS Modules)
├── CHANGELOG.md
├── VERSION
└── docker-compose.yml     # Reference deployment
```

`cmd/reely`, `internal/app/reely`, and `types/reely.ts` keep their names
from the upstream fork; renaming them is a mechanical change deferred to
avoid import churn.

## Checks

Run before every commit (CI runs the same):

| Command | |
|---|---|
| `pnpm typecheck` | server + tests + UI |
| `pnpm test` | Vitest suite |
| `pnpm lint` | Biome (errors block, warnings surface) |

## i18n

There is none: every user-facing string is English, in source. The
translation pipeline was removed in the audit-17 sweep (it maintained
six locale files to localize one string in an unmounted component).

## CI & releases

`ci.yml` runs on every push: typecheck, build, tests, Biome lint, a
multi-arch Docker build, and a Trivy image scan (warn level). A `v*` tag
additionally runs `release.yaml`, which re-gates on the tests, hard-fails
on a CRITICAL fixable CVE, then builds and pushes the multi-arch image
and cuts a GitHub Release.

A release bumps **four files** in lockstep -- `VERSION`, `package.json`,
the `CHANGELOG.md` entry, and the `docker-compose.yml` image pin
(`cajunflavoredbob/cour:x.y.z`); the release workflow fails on any
mismatch. Then tag `vx.y.z` and push the tag.
