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
`scripts/changed-components.py`. Its `web_sidecar` suite selects the sidecar jobs for `sidecar/`, the
contracts, the workspace build files, the Agent compatibility tooling, the CI workflows, and only the
server files the sidecar suite loads (`src/sidecar/`, `src/app.ts`, `src/runtime.ts`,
`src/tools/updates.ts`, the `local-reset.json` fixture, and the server's package and TypeScript
configuration). Other server changes skip them on a pull request and run them on the push to `main`.
Sidecar test changes skip the server job, except `sidecar/tests/fixtures/`, which server tests read.
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

The shared `sidecar/scripts/test.sh` entry point collects the suite once and routes
cases through `suite_runner.py` into three layers:

- `fast` exercises real Talaria code in-process. Boundary fakes replace Agent APIs,
  process inventory, supervisors, HTTP connections and clocks. Workers have no Agent
  paths. An audit hook rejects actual child creation and network access, including
  attempts caught by application error handling. These cases run once.
- `process` proves a named property requiring disposable real children, such as
  pipe transport, lock exclusion, signal delivery, child reaping or crash readback.
  It uses the test interpreter and synthetic Agent state, and runs once.
- `compatibility` exercises an actual supported Agent API or native contract. It
  runs against each of the three immutable supported releases and their interpreters.

`sidecar/tests/process_inventory.json` is the reviewed inventory for process and
compatibility exceptions. Each family names its property, layer and exact pytest
parameter suffixes. Empty suffix means an unparameterized test; `[]` is an actual
empty-string parameter ID. Collection rejects expanded or missing reviewed cases,
Agent fixtures/markers without compatibility classification, and duplicate IDs.
New ordinary tests default to `fast`; a launch or socket operation cannot silently
make them an integration test. Mocks do not trigger OS audit events and remain allowed.

Tests own disposable homes. Every process/compatibility case retains the real
process-leak scan and runner cleanup, including cancellation, crashes and detached
children. Fast cases use prevention instead: a denied launch attempt fails the run
even if its exception is caught, so they need no per-case `ps` child. Existing
synthetic harness tests verify the leak scan preserves a sibling worker's children,
finds its own leaks, and runs after subprocess mocks unwind.

```bash
# Both required kinds of coverage against the active pinned Agent, provisioned in
# the shared cache when HERMES_WEBUI_AGENT_DIR is unset.
TALARIA_SIDECAR_WORKERS=4 sidecar/scripts/test.sh
# No Agent or provisioning required for either of these owning-layer checks.
sidecar/scripts/test.sh --layer=fast
sidecar/scripts/test.sh --layer=process
# Narrow selectors remain serial and retain complete execution/report accounting.
sidecar/scripts/test.sh --layer=fast tests/test_agent_services.py -k worker
sidecar/scripts/test.sh --layer=process tests/test_suite_runner.py
```

Explicit layer selection is a focused check, not a replacement for the default
verification gate. Specify `--layer=fast` or `--layer=process` for offline focused
checks. Omitting the layer keeps the default compatibility request and provisions
the active Agent even when a narrow selector happens to contain no native cases.
`scripts/check-agent-compatibility.py --skip-docker --release TAG`
passes the release identity to this same entry point. The active pin runs fast,
process and compatibility work; the other supported releases run compatibility
work. The Agent promotion probes still run for every release. CI and
`scripts/check-release-agent.py` use these entry points without copying selectors.
The release runner retains its one host-wide worker budget across concurrent
releases; the default local budget stays capped at four. Synthetic orchestration
checks run with `python3 scripts/test-check-agent-compatibility.py` and
`python3 scripts/test-check-release-agent.py` from the repository root.

Workers preserve whole modules within a layer, own their HOME/TMPDIR/basetemp and
emit separate collection, execution and launch journals. The runner verifies that
all selected cases started exactly once and match their JUnit records before
publishing merged evidence. Missing, malformed, duplicated or partial evidence
fails, including serial selectors. Reports and worker logs remain beside the
receipt; `.coverage.json` includes selected layers, exact node IDs and audited
process/network events. Test failures still publish their truthful failing JUnit;
incomplete evidence cannot publish a successful report. Unknown pytest options
remain pytest errors.

Run compatibility checks on the selected Python >= 3.11. The Agent cache under
`$XDG_CACHE_HOME/talaria/agents` is keyed by immutable release identity and retains
its provisioned interpreter. Runs hold the cache entry while testing; retired
releases are pruned by the compatibility checker. Do not use a live Agent, account
or shared mutable Agent as test state. Fixture recording still uses
`sidecar/scripts/record-fixtures.py` for versioned RPC responses.

Attach the before/after coverage map, baseline identity, raw reports and measured
evidence to the PR. Performance evidence must compare the complete required sequence on the same host, immutable Agent
identities/interpreters, warm cache and worker budget. Include all layers and all
three release probes, repeat the sequence, and report wall runtime, cumulative
JUnit cost and instrumented process launches. Do not infer launches from names or
hide compatibility work in another job. The earlier worker-count comparison is
retained in [CI run 39075250998](https://github.com/MaudeCode/talaria/actions/runs/39075250998);
this policy changes test boundaries rather than worker count.

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
