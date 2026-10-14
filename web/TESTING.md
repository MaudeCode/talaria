# Testing Talaria Web

Every suite owns synthetic, disposable state and never touches `~/.hermes`, a live account, a model
provider, or the network. Run commands from `web/` unless noted.

## Gates

| Gate | Command | Notes |
|---|---|---|
| Contracts | `npm run typecheck -w packages/contracts && npm run lint -w packages/contracts && npm test -w packages/contracts` | schema tests, sidecar fixtures, OpenAPI snapshot, monorepo `contracts/fixtures` (publisher snapshot signing, activity scenes) |
| OpenAPI | `npm run openapi && git diff --exit-code -- ../contracts/web-api.openapi.json` | the committed document is the app↔web artifact |
| Server | `npm run typecheck -w packages/server && npm run lint -w packages/server && npm test -w packages/server` | Vitest with the fake sidecar; ~330 tests |
| Sidecar | `sidecar/scripts/test.sh` | pytest against `HERMES_WEBUI_AGENT_DIR`, else the active pinned Agent release, cached and reused as described below; never `~/.hermes` |
| Frontend | `cd packages/frontend && npm run i18n:gate && npm run typecheck && npm run lint && npm test && npm run build:fast` | Vitest + in-memory contract server; the build must reproduce `static/dist` |
| Browser | `../scripts/check-web-browser` (root) or `npm run e2e -w packages/frontend` | Playwright desktop + mobile against the built Node server; uses `sidecar/scripts/replay_sidecar.py` unless `HERMES_WEBUI_AGENT_DIR` is set |
| Docker | `python3 scripts/check-docker.py` (root) | builds the image and smokes single/two/three-container, auto-UID, explicit-UID |
| iOS contract | `app/scripts/validate-upstream-contract` | boots the Node server on the replay sidecar and runs the HTTP/SSE probe plus Swift decoders |
| Everything | `scripts/check web` (root) | `scripts/check-web-server` + frontend gates + browser |

CI (`.github/workflows/web-verify.yml`) runs the server, sidecar (one job per supported Agent release
in `sidecar/agent_support.json`, each provisioned with
`scripts/check-agent-compatibility.py --skip-docker --release TAG`), and frontend jobs selected by
`scripts/changed-components.py`.

## Server tests

`packages/server/src/**/*.test.ts`, Vitest 5, Node 24.

- `bootTestServer({ sidecar, env, deps, ... })` (`src/test/harness.ts`) starts a real HTTP server on an
  ephemeral port with an isolated `HERMES_HOME` / `HERMES_WEBUI_STATE_DIR`. `s.get`, `s.sse(path, until)`,
  and `s.rawStatus` drive it; `s.deps` exposes the runtime for stubs (`s.deps.fetch = ...`).
- `FakeSidecar` (`src/sidecar/fake.ts`) answers recorded fixtures and accepts per-test responders:
  `sidecar.respond('chat.start', (params, emit) => { emit({ event: 'token', data: { text: 'hi' } }); return completed(...) })`.
- Fake authenticator (P-256, CBOR) for passkeys, fake IdP (RS256 JWKS) for OIDC, fake relay via a fetch
  stub, synthetic `state.db` through `node:sqlite`, synthetic git repositories and `file://` remotes for
  git and self-update tests, `InMemoryTransport` for the MCP bin, and a fake serve command for `ctl`.
- Focus a file with `npx vitest run src/tools/updates.test.ts`; `-t "name"` selects one case.
- `HERMES_WEBUI_TEST_HOOKS=1` enables `GET /api/approval/inject_test` and `/api/clarify/inject_test` for
  loopback clients: each queues a fake approval or clarify prompt that `respond` clears without the Agent.

## Sidecar tests

`sidecar/tests` spawns `python -m talaria_sidecar` on the Agent venv with a disposable `HERMES_HOME`
per test (`conftest.py` `SidecarProcess`). `sidecar/scripts/record-fixtures.py` regenerates the recorded
fixtures consumed by the contracts package and the Vitest fake; commit fixture changes together with the
method change. `scripts/check-agent-compatibility.py` (root) provisions an Agent release, runs the Agent probe,
the sidecar suite, and optionally verifies the release container image. Its `--receipt` records the result,
test counts, Python and Web revisions. Supported releases are cached in
`${XDG_CACHE_HOME:-~/.cache}/talaria/agents/<tag>` and reused; a release that leaves
`sidecar/agent_support.json` is deleted, with any interpreter uv downloaded for it, by the next run whose record
no longer lists it. Candidates (`--identity`) and canaries (`--main`) use a temporary checkout removed at exit.

## Frontend tests

`packages/frontend/src/**/*.test.ts(x)` run in jsdom against the in-memory contract server; `e2e/*.spec.ts`
run Playwright against the built assets and the Node server started by `e2e/server.ts`
(`HERMES_E2E_PORT`, `HERMES_WEBUI_AGENT_DIR`, `HERMES_WEBUI_SIDECAR_COMMAND` are honoured; without an Agent dir or
sidecar command it uses the fixture replay sidecar). See
`docs/architecture/frontend-migration.md` for the layout.

## Manual checks

- UI changes: verify desktop, narrow, and mobile widths and attach before/after evidence to the PR.
- Agent-backed flows that need a provider (real chat, TTS, STT, quotas): run against isolated state
  (`HERMES_HOME=/tmp/talaria-home HERMES_WEBUI_STATE_DIR=/tmp/talaria-state talaria-web --foreground`).
- Docker: `python3 scripts/check-docker.py single` needs a Docker daemon.
  The two- and three-container variants also import the staged Agent and send a
  Web API chat through the sidecar to a loopback stub provider. Use
  `python3 scripts/check-docker.py two-container --agent-release v0.21.7`
  to check an older release from `sidecar/agent_support.json`. The Python selector's
  isolated unit checks run with `python3 scripts/lib/test_agent_python.py` from `web/`.
  `python3 ../scripts/check-docker.py agent-upgrade` checks both multi-container
  layouts on disposable named volumes, upgrading the oldest and previous supported
  Agent images to the active pin. It verifies the CLI version, Python, unchanged
  restart reuse, interrupted-copy recovery, rollback, and preserved Hermes home data without
  building the Web image or contacting a model provider.
