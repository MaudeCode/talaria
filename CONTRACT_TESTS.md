# Upstream contract validation

Talaria's server contract is the fork and branch in `UPSTREAM_REPOSITORY` and
`UPSTREAM_BRANCH`. `UPSTREAM_TESTED_SHA` is the reviewed commit the app supports.
The current pin is tagged `v0.51.85` in that fork.

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
| Every app endpoint's method, path, and query shape | `TalariaTests/APIEndpointContractTests.swift` |
| Auth/error decoding and native POST headers | `TalariaTests/APIClientAuthAndErrorTests.swift` |
| Session status and mutation response decoding | `TalariaTests/APIClientSessionListTests.swift`, `TalariaTests/APIClientSessionMutationTests.swift` |
| Chat SSE parsing, heartbeats, redirects, and reconnect status | `TalariaTests/SSEClientTests.swift`, `TalariaTests/StreamReconnectContractTests.swift` |
| Fork drift, route/request-key/SSE changes, and machine-readable feature-gap classifications | `scripts/upstream-watch` |

The fork-only plural provider quota endpoint is newer than the current pin. Its
path and decoding stay covered by the Swift contract tests until a reviewed pin
advance brings it into the disposable live-server baseline.

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
