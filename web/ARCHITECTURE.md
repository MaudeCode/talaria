# Talaria Web architecture

Talaria Web is a TypeScript server on Node 24 plus a React frontend. Everything that needs Hermes Agent
Python code runs in one Web-owned sidecar process. This document describes the shipped layout; the
subsystem contracts it references live in [docs/CONTRACTS.md](docs/CONTRACTS.md), and the row-by-row
inventory of what moved where during the rewrite is
[docs/architecture/backend-parity-matrix.md](docs/architecture/backend-parity-matrix.md).

## 1. Components

```
web/
  package.json                 npm workspaces root: build, test, typecheck, lint, e2e, openapi
  packages/contracts/          @maudecode/talaria-web-contracts — oRPC contract, Zod schemas, SSE unions,
                               sidecar RPC schema and fixtures, OpenAPI generator
  packages/server/             @maudecode/talaria-web — HTTP server, oRPC handlers, SSE, state, sidecar
                               client, bootstrap/ctl/update CLIs, MCP bin
  packages/frontend/           TanStack Start / React SPA consuming the contract client
  sidecar/                     talaria_sidecar (stdlib Python) + its pytest suite; agent_dependency.json pins the Agent
  static/dist/                 frontend build served by the server (built, not committed)
  Dockerfile, docker-compose*.yml, docker_init.bash   node:24-slim image; Python only for the Agent venv
```

### Coupling chain

```
Hermes Agent  <-(sidecar/agent_dependency.json)-  sidecar
                                                  <-(SIDECAR_RPC_VERSION in contracts)-  server
                                                     <-(contracts/web-api.openapi.json + contracts/versions.json)-  iOS app
```

One pin per arrow. The sidecar verifies the loaded Agent revision against its pin and reports
`{agent_revision, pinned_revision, compatible, stale}` at handshake; the server trusts that handshake and
surfaces `agent_runtime_stale` / `agent_incompatible` as `503` conditions. The server never reads the pin.

## 2. Contract package

`packages/contracts` (`docs/architecture/contract-package.md`) defines:

- every HTTP route (method, path, tags, input, output) with `@orpc/contract`; response shapes are pinned
  in `src/views.ts` (known fields typed, documented passthrough for opaque Agent data);
- SSE event unions per stream in `src/sse.ts` (chat, session list, approval, clarify, terminal, kanban);
- the sidecar RPC (`src/sidecar/*`): method params, results, streamed frames, and `SIDECAR_RPC_VERSION`;
- the `RAW_ROUTES` manifest for the handful of non-oRPC routes (SSE, downloads, uploads, OIDC redirects).

`npm run openapi` regenerates `../contracts/web-api.openapi.json`; CI fails when the committed document
differs. The frontend imports the typed client (`@orpc/client` + `@orpc/openapi-client`) and has no
hand-written endpoint schemas.

## 3. Server

`packages/server/src`:

| Area | Modules | Notes |
|---|---|---|
| Pipeline | `app.ts`, `server.ts`, `http/*`, `auth/*` | profile cookie → `Origin: null` rejection → auth (public / operator-only paths, profile mismatch 403) → startup gate (503 `startup_recovery`) → handler; CSRF (same-origin + HMAC token, non-browser bypass), security headers and CSP, trusted proxies, TLS, worker budget and per-client stream cap, 20 MiB body cap, multipart |
| Routes | `api/router.ts`, `api/*-router.ts`, `api/*-raw.ts`, `api/sse-routes.ts` | oRPC handlers per contract namespace plus raw routes; `HttpError(status, message, extra)` envelopes |
| Sessions | `sessions/store.ts`, `session.ts`, `list.ts`, `drafts.ts`, `shares.ts`, `journal.ts`, `titles.ts`, `export.ts` | byte-compatible `sessions/<sid>.json` (key order, atomic `.tmp.<pid>` writes, `.bak` shrink guard), `_index.json`, drafts, shares, run and turn journals |
| Chat | `sessions/turn.ts`, `streams.ts`, `pending.ts`, `channels.ts`, `events.ts` | stream registry, SSE replay from journals, approvals/clarify/goals over the sidecar, cancel/steer, compression, titles, metering |
| Agent sessions | `sessions/state-db.ts`, `cli-sessions.ts`, `gateway-watcher.ts`, `completions.ts` | read-only `state.db` projection through `node:sqlite`; gateway watcher per profile home; background completion drain and wake-up turns |
| Workspace | `workspace/*` | hardened git runner, worktrees, rollback checkpoints, uploads, media, zip |
| Tools | `tools/*` | skills, memory, prompts, crons, kanban, extensions + sidecar proxy, MCP health, terminal (`node-pty`), insights, system health, self-update (`tools/updates.ts`), log hygiene |
| Providers | `providers/*` | model catalogs, quotas, OAuth device flows, TTS |
| Profiles | `profiles/*`, `settings.ts`, `onboarding.ts` | profile homes, `config.yaml` and `.env` writes, settings defaults and migrations |
| Relay | `sessions/relay.ts` | Talaria Relay pairing, presence leases, Ed25519-signed publisher |
| Sidecar | `sidecar/client.ts`, `discover.ts`, `fake.ts` | newline-delimited JSON-RPC 2.0 over stdio with streamed frames and cancellation; restart with backoff; Agent discovery; the Vitest fake |
| CLI | `cli/launcher.ts`, `ctl.ts`, `dotenv.ts`, `supervise.ts`, `bin/*` | `talaria-web` bootstrap, `ctl`, `.env` precedence, the serve supervisor, `talaria-web-mcp` |

State ownership: WebUI-owned files (sessions, settings, auth records, journals, shares, drafts, relay
config, extension state) are written only by the server, in the same formats the Python backend used, so
an existing installation upgrades without migration. Agent-owned files (`config.yaml`, `.env`, profiles,
skills, memories) are read and written as file formats by the server; `state.db` writes and the
`delete_cli_session` transaction go through the sidecar.

Concurrency: one event loop, no locks. Per-session serialization, stream slots, the coalesced index
writer, and the update lock are promise-based; `docs/lock-ownership.md` lists the ordering rules that
survived the move from threads.

Self-update (`tools/updates.ts`): a recognized clean checkout fast-forwards to the newest completed
release set (stable) or `origin/main` (experimental), stamps `_release.json` from immutable git blobs,
and restarts once active work drains by exiting with code 75 so the `talaria-web serve` supervisor
respawns the worker with the same PID tree that ctl, launchd, and systemd track. npm and container installs
report `manual_update`.

## 4. Sidecar

`sidecar/talaria_sidecar` (`docs/architecture/sidecar-rpc.md`) is spawned as
`<agent venv python> -m talaria_sidecar` with `PYTHONPATH` pointing at the sidecar package and the Agent
appended to `sys.path`. Namespaces: `runtime`, `chat` (AIAgent turns with streamed callbacks, interrupt,
steer), `approval`, `goals`, `profiles`, `cron`, `kanban`, `skills`, `commands`, `plugins`, `providers`,
`models`, `aux` (auxiliary LLM calls), `text` (redaction, portal tags), `stt`, `mcp`, `process`
(background completions), `state_db`, `gateway`, `worktree`, `config`. Each method has a Zod schema in
the contract package and a recorded fixture under `packages/contracts/fixtures/sidecar/` used by both
the pytest suite and the Vitest fake. `sidecar/scripts/replay_sidecar.py` replays those fixtures and stages
one approval so browser e2e and the iOS contract runner need no Agent.

## 5. Frontend

`packages/frontend` keeps the TanStack Start structure documented in
`docs/architecture/frontend-migration.md`: routes, features, the contract client (`src/api/orpc.ts`,
`client.ts` with CSRF, GET coalescing, 401 redirect, timeouts), SSE consumers on the contract event unions,
the sandboxed extension platform (`docs/architecture/extension-protocol-v1.md`), i18n, service worker, and
the in-memory contract server used by Vitest (`src/adapters/memory.ts`). `npm run build:fast` produces
`static/dist/`, which is not committed: CI builds it for tests, the npm package and the container image.

## 6. Runtime and startup

```
talaria-web            .env → discover Agent → sidecar preflight → detached start (or attached under a supervisor)
  └─ serve             supervisor: spawns the worker, forwards signals, respawns on exit code 75
       └─ worker       loadConfig → launchSidecar (handshake) → createDeps → HTTP listen → workers
                        (relay publisher, completion drain, hygiene ticker, gateway watchers, MCP probes)
```

Readiness: `/health` reports `starting` until session recovery finishes. The Agent pin records the tested
identity; a different importable revision may run with a warning. Agent-backed routes answer `503` with
`condition: sidecar_unavailable | agent_runtime_stale | agent_incompatible` when the sidecar is down, the
loaded checkout changes, or a required capability is missing. Operator config reads and writes can still
work after an Agent import failure so SSO and authorized recovery remain available. Shutdown drains streams
and stops workers on SIGTERM/SIGINT.

## 7. Adding an endpoint

1. Add the route to the contract namespace in `packages/contracts/src/routes/*.ts` with pinned input and
   output schemas (put the response shape in `src/views.ts`).
2. Implement the handler in the matching `packages/server/src/api/*-router.ts`; sidecar-backed work adds
   a method to `packages/contracts/src/sidecar/namespaces.ts`, the Python implementation under
   `sidecar/talaria_sidecar/methods/`, a recorded fixture, and a pytest case.
3. Regenerate OpenAPI (`npm run openapi`) and, if the iOS app consumes it, update its decoders and
   `contracts/versions.json`.
4. Test through `bootTestServer` with the fake sidecar (see [TESTING.md](TESTING.md)).
