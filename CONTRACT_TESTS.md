# Contract validation

App commands and source paths in this document are relative to `app/`.

Talaria's server contract is the checked-out `web/` tree in this monorepo.
Shared versions, schemas, and synthetic fixtures live in root `contracts/`.

App HTTP/SSE requests to Web and Relay, including Kanban streams and widget
refreshes, include public build metadata in `X-Talaria-Client`:
version, build number, source revision, release-set identifier and supported
contracts. The same JSON is logged once at launch in the `release` OSLog category.
It contains no account, device, server or credential data. Source/release IDs are
null for development or inconsistent stamps. External media requests omit this
header, and cross-origin redirects strip it. These diagnostics never enforce identical peer versions.

Release builds use root `scripts/stamp-release.py app --version X.Y.Z
--build-number N --source-revision SHA` before archiving. The helper stamps the
App and widget Info.plists from a clean exact checkout; the archive-version gate
still checks the App and both extensions against the selected version/build.

## One command

From the repository root, run `scripts/check contracts`; it runs
`app/scripts/validate-upstream-contract`. From `app/`, run:

```bash
scripts/validate-upstream-contract
```

The command builds and starts the current local `web/` source, including
uncommitted edits, with test-owned home, state, workspace, password, and file
data. The fixture replay sidecar answers every Agent-backed route, so no Hermes
Agent, provider, network, or owner state is involved. It runs the live HTTP/SSE
probe and then the focused Swift contract classes against the recorded responses.

To validate an immutable monorepo revision, export its `web/` tree with:

```bash
scripts/validate-upstream-contract --ref <monorepo-tag-or-commit>
```

Logs, source identity, live fixtures, and test output remain under
`app/.codex-tmp/upstream-contract/` from the repository root. `--server-only`
runs only the HTTP/SSE half; `--responses-output FILE` copies the recorded
live responses. `scripts/test-validate-upstream-contract` tests the command.

## Where it runs

`scripts/changed-components.py` selects the `contracts` suite for changes to root
`contracts/`, the Web contracts package, server and sidecar, the App networking,
model and Live Activity sources, Relay HTTP-facing Convex modules, and the
contract scripts themselves. In `ci.yml`:

- The Linux `Web contract probe` job runs
  `scripts/validate-upstream-contract --server-only --responses-output ...` and
  uploads the live responses as the run's `contract-fixture` artifact.
- App test shard 0 (`app-tests.yml`, called by `ci.yml`) waits for the probe, downloads
  that artifact, and runs the native contract classes (`ContractReadinessTests`,
  `SharedContractTests`, and the API client, SSE and reconnect contract tests)
  together with
  `APIClientSessionListTests/testLiveUpstreamContractResponsesDecodeWhenSupplied`
  against it in one `xcodebuild` run. A missing fixture skips the test, so the
  job requires an explicit pass.

Releases repeat the gate in `release-set.yml`: `scripts/check-release-contracts.py`
checks the selected App against the selected and still-supported Web sources and
runs the Web and Relay shared-fixture suites at their selected refs, and
`scripts/check-previous-app.py` checks the previously released App against the
selected Web.

## Executable map

| Behavior | Executable evidence |
| :--- | :--- |
| Local Web source identity and isolated candidate export | `scripts/validate-upstream-contract` |
| Health, password auth, cookie state, unauthorized access, native-client CSRF behavior | `scripts/upstream-contract-probe` |
| Server-independent sessions, projects, workspaces, models, providers, settings, reasoning, profiles, personalities, commands, and memory response keys | `scripts/upstream-contract-probe` |
| Synthetic workspace list/file/raw-file reads | `scripts/upstream-contract-probe` |
| Disposable create, detail, status, rename, pin, archive, move, truncate, branch, delete, and cleanup | `scripts/upstream-contract-probe` |
| SSE content type and controlled `initial`/`approval` events | `scripts/upstream-contract-probe` |
| Live response values decoded by Talaria's real `Codable` models | `TalariaTests/APIClientSessionListTests.swift` through `scripts/validate-upstream-contract` |
| Every app endpoint's URL path and query shape | `TalariaTests/APIEndpointContractTests.swift` |
| Every endpoint family's HTTP method, read off the `URLRequest` the client builds | `TalariaTests/APIClient*Tests.swift` request-interception tests |
| Auth/error decoding and native POST headers | `TalariaTests/APIClientAuthAndErrorTests.swift` |
| Native OIDC capability, callback/state/PKCE/server binding, exchange cookies, expiry, replay, cancellation, and server isolation | `TalariaTests/APIClientAuthAndErrorTests.swift`, `TalariaTests/AuthManagerStateTests.swift` |
| Session status and mutation response decoding | `TalariaTests/APIClientSessionListTests.swift`, `TalariaTests/APIClientSessionMutationTests.swift` |
| Chat SSE parsing, heartbeats, redirects, and reconnect status | `TalariaTests/SSEClientTests.swift`, `TalariaTests/StreamReconnectContractTests.swift` |

The plural provider quota endpoint is covered by the Swift contract tests
against the local Web implementation.

`Endpoint` owns only the URL, so the matrix proves path and query and nothing
else; each call site's method is asserted where that call's request is
intercepted. The SSE endpoints (`/api/chat/stream`, `/api/approval/stream`,
`/api/clarify/stream`, `/api/kanban/events/stream`) are the named exception:
`EventSource` opens them from a URL and never sets `httpMethod`, so they carry
URLSession's default GET rather than a method Talaria chooses.

Native OIDC is capability-gated. Compatible servers
report `oidc_native_handoff_enabled` and expose
`POST /api/auth/oidc/native/start`, `/exchange`, and `/cancel`. Talaria completes
that flow through `ASWebAuthenticationSession` and exact-server cookie jars.

Web exempts pre-login requests from CSRF checks. The probe requires a
cross-origin `POST /api/session/new` after login to be rejected, and verifies
that native mutations without an Origin header succeed.

`SharedContractTests`, the contracts package Vitest suite (`web/packages/contracts`), the frontend
contract suite, and `relay/tests/sharedContracts.test.ts` consume the same root
fixtures. They exercise Web publication, signed Relay HTTP ingestion, native
registration, aggregate responses, and Activity Scene decoding.

## Clarification batches

Current Web servers provide ordered `steps` containing `qid`, `question`, `choices`,
and `multi_select`. The app renders these fields directly and posts `answers`
keyed by `qid`, with arrays for multi-select steps. The server shapes the Agent's
reply. The live probe captures a single-question multi-select prompt from the
replay sidecar through Web's pending endpoint and SSE stream, submits keyed answers,
and passes the pending response to the Swift decoder check.

The following compatibility path applies only when `steps` is absent. Delete it
once all supported Web servers ship `steps`.

Talaria also accepts the additive `questions` payload alongside the
single-question contract. Each question carries its wire `qid`,
question text, choices, and optional `multi_select` flag. A batch-only `initial`
event is a clarification, not an approval.

The POST route and outer request stay unchanged. Its `response` string contains
JSON `{"answers":{"q0":"typed answer","q1":["first choice","second choice"]}}`.
The Agent's batch callback parses this envelope; sending plain text instead yields
blank answers. Talaria submits the batch only after collecting each question's
answer. `ClarificationTests` covers decoding, wire values, question progression,
and retry retention; `ChatPrimaryStreamUITests` verifies choices, composer input,
and the answer map received through the HTTP fixture.

## Contract changes

A contract change ships as one monorepo diff that updates `contracts/`, the
producer, every affected consumer, and their checks together.
