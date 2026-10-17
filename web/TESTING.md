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
Each Agent job first runs the synthetic runner checks so isolation and cleanup failures surface
before the longer real-Agent suite.

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

The combined updater proof in `sidecar/tests/test_agent_update_flow.py` drives
real HTTP apply/force requests through the Node runtime and Python mutation
lease against disposable supervised backends. Build contracts and server first,
use Node 24 on PATH, then run `sidecar/scripts/test.sh tests/test_agent_update_flow.py`.
CI builds that runtime in each supported-Agent matrix job, so the combined proof
runs there. Without those build artifacts locally the proof is explicitly skipped; the
process-only sidecar suite still runs independently. The proof uses synthetic
release records and local Git remotes, with no provider or live service access.

Full sidecar suites use `TALARIA_SIDECAR_WORKERS`, a positive integer. The automatic count is the
CPU count available to the process, capped at 4. Set `TALARIA_SIDECAR_WORKERS=1` for a serial full
suite, or explicitly request a higher count, including 8. CI sets its count explicitly. File/node
selectors, `-k`, `-m`, and other pytest options run serially and pass through unchanged; `--junitxml`
alone still permits parallel execution. For example:

```sh
TALARIA_SIDECAR_WORKERS=4 sidecar/scripts/test.sh
TALARIA_SIDECAR_WORKERS=1 sidecar/scripts/test.sh
sidecar/scripts/test.sh tests/test_checkpoints.py -k restore
sidecar/scripts/test.sh tests/test_suite_runner.py
```

The runner initializes pytest once, collects the complete suite, and assigns whole modules to
disjoint groups balanced by case count. Each worker has its own HOME, TMPDIR, pytest basetemp,
log, execution journal, and JUnit report. A collection failure, incomplete/duplicate execution,
crashed worker, or missing/invalid report fails compatibility. Worker process groups and detached
test processes naming the disposable state directory are cleaned up on every exit; Linux also
reaps terminated orphans throughout execution, preserving worker exit statuses. The existing
per-test process-leak fixture still detects and kills leaks. Both cleanup paths use an untruncated
process snapshot, including when readline changes the native terminal-width environment.
Linux kernels without the optional proc children entry use that same process snapshot for orphan
discovery, including startup failure and cancellation.
In-process chat tests receive a fresh Agent cache per case without extending other test mocks
into the process-leak scan. Native-supervisor fixtures wait for
their disposable source/home processes to exit, including restarted supervisors; a published
recovery journal or removed PID marker is not exit proof.
Service scenarios synchronize on live successor identity and terminal recovery completion.
Real-process coverage also forces natural exit between liveness and identity probes;
normal custody and live identity changes remain refusals in both verification modes.
Direct Agent helpers inherit the sidecar's no-lazy-install policy, so native Git selection uses
the available Git without provisioning PM in each disposable home. Tests that exercise bootstrap
policy can explicitly override that default.

One merged JUnit report remains beside each compatibility receipt. Per-case durations and
failure/error/skip information are preserved, with slow tests and modules printed after the run.
Worker logs and collection/execution journals remain under `<report>.workers/run-*`, including
on failure. Direct runs without a report retain them under `web/.codex-tmp/sidecar-pytest/run-*`.
The receipt schema, Agent probes, supported identities, and Docker verification are unchanged.

`scripts/check-release-agent.py` treats the same worker setting as one host-wide budget. It divides
that budget between concurrently checked releases, or queues releases when the budget is smaller
than their count. It prints the budget and each release's allocation; each suite prints its own
worker count and the total budget. The independent CI matrix jobs each own their runner's budget.
Synthetic release-budget checks run with `python3 scripts/test-check-release-agent.py` from the root.

To compare settings, keep the Talaria source, pinned Agent identity/interpreter, host, and warmed
Agent cache fixed. Run `scripts/check-agent-compatibility.py --skip-docker --release TAG --receipt PATH`
from the root at 1, 2, 4, and 8 workers, record wall duration and sampled peak process-tree RSS,
and compare receipt verdicts/counts and collected/executed node IDs. Repeat promising settings
before choosing one; CPU count alone does not establish the fastest setting.

CI uses eight workers based on the [completed same-host comparison](https://github.com/MaudeCode/talaria/actions/runs/39069042876)
at source `d2b6e13a422f8e152737d1928a6eac50c6570bc2`, with warmed immutable Agent v0.22.2,
Python 3.14.3, and a four-CPU Linux runner. All 928 cases retained the same verdict, counts,
node IDs, and skip set at every setting. Four and eight workers were repeated before selection.

| Workers | Runs | Median wall seconds | Max sampled tree RSS MiB |
|---:|---:|---:|---:|
| 1 | 1 | 1038.959 | 514.3 |
| 2 | 1 | 564.081 | 700.6 |
| 4 | 2 | 487.290 | 914.9 |
| 8 | 2 | 387.048 | 1343.6 |

Eight workers improved median wall duration 2.684x over serial and passed a fresh canonical run
at 383.816s with 1372.3 MiB sampled peak tree RSS. The recorded memory budget was 11992.3 MiB
(75% of host RAM). Separate full one/four/eight-worker comparisons on v0.22.0 and v0.22.1 also
preserved all 928 node IDs, complete probe evidence, counts, and their version-specific skip sets.
Eight workers improved those releases' wall durations 2.627x and 2.797x, respectively. The
automatic local count stays capped at four; `TALARIA_SIDECAR_WORKERS=1` remains the serial escape hatch.

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
  `python3 scripts/check-docker.py two-container --agent-release v0.22.0`
  to check an older release from `sidecar/agent_support.json`. The Python selector's
  isolated unit checks run with `python3 scripts/lib/test_agent_python.py` from `web/`.
  `python3 ../scripts/check-docker.py agent-upgrade` checks both multi-container
  layouts on disposable named volumes, upgrading the oldest and previous supported
  Agent images to the active pin. It verifies the CLI version, Python, unchanged
  restart reuse, interrupted-copy recovery, rollback, and preserved Hermes home data without
  building the Web image or contacting a model provider.
