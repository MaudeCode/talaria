# Upstream contract validation

Talaria's server contract is the fork and branch in `UPSTREAM_REPOSITORY` and
`UPSTREAM_BRANCH`. `UPSTREAM_TESTED_SHA` is the reviewed commit the app supports.
The current pin is the untagged `master` merge commit `14105699`, which includes
the native OIDC handoff from Hermes WebUI PR #15.

## One command

Run the complete pinned contract check with:

```bash
scripts/validate-upstream-contract
```

The command clones the configured fork, verifies its default branch, checks out
the pin into an isolated run directory, starts the server with synthetic home,
state, workspace, password, and file data, then runs the live HTTP/SSE
probe and focused Swift tests. It never reads or mutates an owner's Hermes state.

To test a candidate tag or commit without moving the pin:

```bash
scripts/validate-upstream-contract --ref <tag-or-commit>
```

Logs, the resolved commit, and test output remain under
`.codex-tmp/upstream-contract/`. A failure names the endpoint, fixture, decoder,
or stream boundary that failed.

## Executable map

| Adopted behavior | Executable evidence |
| :--- | :--- |
| Fork identity, default branch, candidate ancestry, immutable pin | `scripts/validate-upstream-contract` |
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
| Fork drift, route/request-key/SSE changes, and machine-readable feature-gap classifications | `scripts/upstream-watch` |

The fork-only plural provider quota endpoint remains covered by the Swift
contract tests and is included in the current fork pin.

`Endpoint` owns only the URL, so the matrix proves path and query and nothing
else; each call site's method is asserted where that call's request is
intercepted. The SSE endpoints (`/api/chat/stream`, `/api/approval/stream`,
`/api/clarify/stream`, `/api/kanban/events/stream`) are the named exception:
`EventSource` opens them from a URL and never sets `httpMethod`, so they carry
URLSession's default GET rather than a method Talaria chooses.

Native WebUI OIDC is capability-gated in the current pin. Compatible servers
report `oidc_native_handoff_enabled` and expose
`POST /api/auth/oidc/native/start`, `/exchange`, and `/cancel`. Talaria completes
that flow through `ASWebAuthenticationSession` and exact-server cookie jars.

The 2026-08-31 advance was explicitly accepted after the WebUI focused auth
suite, five-shard CI, two bot-review passes, and Talaria's focused/full XCTest
runs. The disposable candidate runner stopped before its Swift phase because
the existing CSRF probe expected `POST /api/auth/login` to reject a request that
the merged server accepts. The operator directed that no additional validation
run be performed; the preserved artifact records that held probe mismatch.

## Clarification batches

Talaria also accepts the additive `questions` payload introduced by WebUI commit
`f190f680d0d04b0decc416ae7f7cb86e4465eb81` without changing the legacy single-question
contract or advancing `UPSTREAM_TESTED_SHA`. Each question carries its wire `qid`,
question text, choices, and optional `multi_select` flag. A batch-only `initial`
event is a clarification, not an approval.

The POST route and outer request stay unchanged. Its `response` string contains
JSON `{"answers":{"q0":"typed answer","q1":["first choice","second choice"]}}`.
The Agent's batch callback parses this envelope; sending plain text instead yields
blank answers. Talaria submits the batch only after collecting each question's
answer. `ClarificationTests` covers decoding, wire values, question progression,
and retry retention; `ChatPrimaryStreamUITests` verifies choices, composer input,
and the answer map received through the HTTP fixture.

## Pin advance

The runner never writes `UPSTREAM_TESTED_SHA`. A changed fork commit cannot move
the support claim as a side effect of drift detection or validation.

To advance the pin, validate the candidate first. On a ticket branch, update
`UPSTREAM_TESTED_SHA` and the human-readable tag here and in `DEVELOPMENT.md`,
then rerun the command with no `--ref`. Commit the pin only with the preserved
run directory and green Swift result recorded in the Kaneo or PR handoff.

## Drift watch

`scripts/upstream-watch --fetch` reads the same configured fork and branch. The
weekly workflow uploads its report as an artifact. A report is triage evidence,
not permission to edit the pin or sync the public parent into the fork.

`docs/agents/feature-gap-index.md` remains the machine-readable classification
source. Keep tracker, branch, and handoff instructions outside its parsed table.
