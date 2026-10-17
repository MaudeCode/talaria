# Web to Hermes Agent dependency contract

Talaria Web depends on Hermes Agent through exactly one boundary: the Python
sidecar (`sidecar/talaria_sidecar`, [sidecar-rpc.md](sidecar-rpc.md)). The
TypeScript server imports no Agent code and reads Agent-owned files only as file
formats (`config.yaml`, `.env`, profiles, skills, memories, `state.db` read-only
projection). Every Agent module import lives in the sidecar's `methods/`
package, on the Agent's own venv interpreter.

## Tested identity

`sidecar/agent_dependency.json` records the tested external Agent: a stable
release tag, its exact package version and peeled source commit, and the release
image digest. The launcher fetches the installer from that commit when it
installs an Agent; existing installations are discovered and retained, never
downgraded. Both multi-container Compose variants inherit their Agent image from
the same file through Compose `extends`.

`sidecar/agent_support.json` lists exactly three stable Agent releases Talaria
supports, each with its tag, package version, peeled commit, release image
digest, and the ticket that validated it. The active pin must be one of them;
the checker refuses a record with any other count, a repeated identity, a
mutable reference, or a pin outside the set. Promoting a newer release replaces
the oldest entry only after the candidate passes.

At handshake the sidecar reports `{agent_revision, agent_version, pinned_revision,
pinned_version, compatible, stale, update_state}`. `compatible` means the Agent
imported; a different revision than the pin gets a warning and can attempt Agent
operations. Individual methods refuse missing capabilities and named-profile
credential isolation failures. A checkout changed after import returns
`503 agent_runtime_stale` for Agent operations until restart. `config.get` and
`config.set` remain available after an Agent import failure if the RPC handshake
and YAML parser work, so operator auth and repair do not depend on Agent imports.
Config saves use the Agent's comment-preserving full-state replacement writer when available,
including deliberate key removals. The sidecar stages the resolved file's document and checks
the original symlink again before replacing its target, retaining the target's permissions.
Older Agents and failed Agent imports use the YAML parser with line folding disabled so paths
and prompts containing backslashes survive a save unchanged. Writer failures propagate without
falling back to a rewrite that would discard comments.
`/health` exposes the same `compatibleAgent`
identity in its `release` block (`tag, version, sourceRevision, releaseSet,
contracts, compatibleAgent`); it names the tested dependency, not whichever Agent
an operator installed.

Run `python3 scripts/check-agent-compatibility.py` from the monorepo root when
changing the pin or preparing a release; `--release TAG` checks one supported
release, `--identity JSON` an unpromoted candidate, and `--main SHA` an Agent
`main` canary. Pull requests that change the sidecar, its contracts, the
checker, or the record run it for all three supported releases, and the release
gate repeats that against the release plan's Web source. The gate requires a
published, non-prerelease GitHub release, fetches only that release tag,
requires it to peel to the recorded commit, installs its locked dependencies on
the newest Python the lockfile allows, exercises real Agent imports and the
sidecar's `SessionDB` write path, and runs the sidecar pytest suite on that
interpreter. `--receipt PATH` writes the result, failing or not, with test
counts, the Python and Web revisions, and the JUnit report beside it. Unless
`--skip-docker` is set, it also requires the recorded digest's image to come
from the recorded commit (its OCI revision label, or a clean CI build stamp on
images that have none) and to be published under the release tag or the
`rc.N-<tag>` release attempt whose Git tag is that commit, then repeats the
probe against that digest with networking disabled. It uses disposable homes and databases and never production
credentials or provider requests. A passing identity is a tested combination,
not a requirement that independently installed Agent or peer component versions
be equal. Unreleased Agent `main` canaries never change this pin or the
support record.

Compatibility means Talaria works with the selected Agent. The gate tests the
imports and native update APIs Talaria uses, real `SessionDB` and sidecar writes,
the full sidecar suite, safe handling of retained state, and the immutable source
and image identity. It does not require Talaria to repair Agent-internal bugs or
preserve every behavior of a previous Agent release.

The same disposable probe retains upstream diagnostics for SSH file approval,
MCP execution deadlines, and compression backoff. SSH observations exercise real
write/edit tools with absolute and task-relative paths, with synthetic human
approval responses. MCP observations discover stdio stub servers and use the
real registry/executor for direct, deferred, sequential and batch calls.
Compression observations use the real compressor/preflight with synthetic clocks,
token counts and a callback that never contacts a provider. Each probe owns its
HOME and denies network access. These observations and named MCP findings remain
in the receipt even when Talaria is compatible; they do not become claims that
Agent bugs are fixed. Exceptions that prevent the probe from running still fail
the check. Source and image must reproduce the SSH/compression observations.

Agent v0.22.2 is supported with its observed upstream limitations: task-relative
SSH configuration approval can be bypassed, explicit MCP budgets can be shortened
by the executor's generic deadline, and transcript growth does not lift structural
compression backoff. Those are Agent behaviors; Talaria does not patch, vendor or
wrap the Agent to change them.

Candidate and canary probes, and supported releases from v0.22.1 onward, also
replay retained cron records written by the v0.22.1 Agent and Web manual-execution
writers. The fixture at `sidecar/tests/fixtures/cron-retained-v0.22.1.json` records
that base revision. Talaria must reconcile supported manual results or return its
explicit unsupported-recovery refusal without changing retained evidence. The
receipt records this result as `agentProbe.retainedCron.manualRecovery`. The probe
also records direct upstream pending Bot Chat drain failures as diagnostics. Talaria's
normal/force update preflight still rejects replacement when retained manual or
deferred delivery obligations require capabilities the target lacks; support for
clean installations does not authorize an unsafe retained-state update. The
sidecar and server regression suites cover these protections.

Both Agent update paths acquire the Agent's native checkout lock and durably
record writer recovery obligations before the compatibility scan. Unknown
owners, foreign profile homes, unreadable identity evidence, or an unacknowledged
drain refuse the update. Gateways exit through their own drain; the updater does
not force-kill them. Attested supervisors are stopped only after the owned
gateway exits. Bare and Windows gateway obligations retain the Agent's native
paused-gateway journal. Supervised POSIX services retain their exact supervisor
in Talaria's companion record below. POSIX discovery distinguishes the supervisor PID
from the gateway PID attested by the native profile PID/lock files. Only that
verified runtime is excluded from bare discovery. Parent chains, canonical
process identities and native birth stamps are bracketed and rechecked before
custody and stop; unrelated descendants and ambiguous ownership still refuse.

Supervised dashboard/serve writers from the same installation's native ledger
join that same lease. Native loaded launchd inventory and systemd MainPID
ownership identify their exact supervisor. Talaria records the original service,
profile, endpoint, configuration digest and process tree before requesting the
backend's native retirement prepare/commit fence. Busy or indeterminate work
refuses the update. After committed admission closure, SIGTERM runs the native
graceful shutdown; the lease waits for the backend and its writer descendants,
then disarms the original supervisor. A timeout never escalates to SIGKILL.
Unexpected children, respawn or an unproved stop prevent source mutation.

Lifecycle calls use the backend's existing owner-local session credential.
For a dashboard protected by native basic auth, the owning OS user's existing
configured signing key can authenticate a short-lived native session. Neither
session credentials nor retirement permits are persisted in recovery records.
A backend whose native authentication cannot be established remains an
actionable refusal; Talaria does not alter authentication or service config.
Unknown, manual, Desktop-owned and foreign-profile backends remain refused.

The native gateway recovery reader verifies a launchd PID, which can be a wrapper
without a working dashboard listener. Backend debt and supervised-gateway
readiness debt therefore live separately
under `$HERMES_HOME/.talaria-agent-services/<checkout-hash>.json`, alongside the
existing lease rather than in the gateway-only token. This additive companion
extends the manual-execution recovery record pattern: private atomic writes and
directory fsync, one native checkout lock, source-baseline/move evidence copied
from the native journal, and dependency-repair intent recorded before repair.
It never patches or replaces Agent source, its native journal, or the pin.

The companion also records the gateway runtime and supervisor stop identities,
completes an interrupted disarm under the native checkout lock, and verifies the
actual gateway through native home-based PID/lock readiness. A fresh wrapper
alone cannot erase gateway readiness debt. Custody is written to the companion
before retiring any overlapping native service obligation, so the native reader
cannot separately replay that supervisor or regenerate its configured wrapper.

Each backend obligation clears only after a live same-install/profile ledger
identity, exact supervisor ancestry, unchanged service configuration and an
authenticated identity response at its original endpoint all agree. A fresh
wrapper PID or unrelated listener is insufficient. Recovery adopts an already
verified successor instead of starting a duplicate. Each service is settled
independently; a failed restart retains its own obligation while safe siblings
are restored. Services that were stopped before the attempt are never recorded
or started. A new sidecar handshake retries retained backend debt through the
same isolated recovery worker and checkout lock. Recovery runs asynchronously so
supervisor/readiness waits do not consume the handshake's RPC deadline. Repeated
handshakes share one recovery worker. Agent admission stays closed
while that debt exists. Unsafe source, failed repair, failed graceful stop or
unverified readiness retains durable debt for an explicit repair/retry.

`runtime.agent_mutation` extends the dependency-sync supervisor's lifetime-lease
and child-reaping design across the existing Web updater's operations:

| Action | Result |
| --- | --- |
| `begin` | Acquire native custody, adopt prior pause debt, prove writer quiescence, return a private lease token. |
| `git` | Execute the existing updater's command under that custody and the native checkout journal gate. |
| `sync` | Repair dependencies while writers remain paused. |
| `finish` | Verify the tree and repair, resume the recorded owners, then release custody. |

The supervisor owns every Git/dependency child. Cancellation or a lost sidecar
pipe stops and reaps an active writer before recovery is judged. A killed
supervisor leaves the native journal adoptable, and a mutator inherits the
native checkout lock. Torn source, failed repair, or unverified resume retains
the obligation. Patch paths are recorded before atomic local restores; a HEAD
that did not move cannot certify an interrupted patch. A successful atomic
restore gets a verified native baseline checkpoint. A paused broken environment
can repair without importing its main runtime first; verified resume then uses
the current Agent interpreter and its canonical recovery reader.

Within the held lease, the server inspects immutable target Git blobs and
retained `cron/manual_runs` and `cron/bot_chat_pending` records, before dependency
repair intent or source changes. It checks resolved root and named-profile
homes, or the pinned home in isolated-profile mode. Manual recovery and deferred
delivery have separate compatibility verdicts in `updates.apply` and
`updates.force`; clients render the existing error message. Web never imports
target Python into the live sidecar, rewrites pending cron formats, discards
records, or resubmits a retained task. Already-incompatible recovery returns
`cron_execution_unverified` before any retained-record write.

Web's existing repair-intent marker stays present through verified gateway
resume, even when HEAD is unchanged. The sidecar's common Agent admission guard
refuses new work while that marker remains; repair RPCs remain available. Web
restart is scheduled only after verified resume, and new admission stays closed
until that restart. A pending repair finishes the installed revision first; an
explicitly confirmed legacy release without a sync entry point retains the
existing recovery escape, still behind the same writer and compatibility gates.
Update checks do not restore stashes or mutate source. Interrupted local changes
are reconciled only on an explicit apply within the writer lease.

The compatibility gate proves Talaria's existing calls still work; it cannot see
new Agent capabilities. For what a release or `main` SHA adds, modifies,
deprecates or removes, run the
[`upstream-release-review`](../../../.agents/skills/upstream-release-review/SKILL.md)
skill: `python3 scripts/review-agent-range.py prepare --base <reviewed SHA>
--candidate <tag|main>` prepares the exact range, and the skill classifies each
change against the sidecar, contracts, server and UI. It files validated bugs
and features in Kaneo, holds other findings for owner approval, and never
changes the pin.

## Dependency classes

| Class | Sidecar namespace | Agent modules |
|---|---|---|
| Chat execution | `chat.*`, `approval.*`, `goals.*` | `run_agent.AIAgent`, `tools.approval`, `hermes_cli.goals` |
| Profiles | `profiles.*` | `hermes_cli.profiles` |
| Operator configuration | `config.*`, `personalities.*` | YAML parser on the Agent interpreter; no Agent import required for `config.get`/`config.set`; `hermes_cli.personality` (the personality catalog) |
| Commands and plugins | `commands.*`, `plugins.*`, `skills.*` | `hermes_cli.commands`, `hermes_cli.plugins`, `agent.skill_utils`, the prompt builders (`agent.plan_prompt`, `agent.learn_prompt`, `agent.initiate_setup_prompt`, `hermes_cli.init_command`) |
| Providers and models | `providers.*`, `models.*`, `aux.*` | `hermes_cli.models`, `hermes_cli.auth`, `hermes_cli.main_provider_setup` (aux slot list), `agent.credential_pool`, `agent.auxiliary_client`, `agent.model_metadata` |
| Scheduling | `cron.*`, `kanban.*`, `process.*` | `cron.jobs`, `cron.scheduler`, `hermes_cli.kanban_db`, the process registry |
| Session state | `state_db.*` | `hermes_state.SessionDB` |
| Text and media | `text.*`, `stt.*`, `mcp.*` | `agent.redact`, STT helpers, MCP discovery |
| Gateway lifecycle | `gateway.*`, `worktree.*` | the `hermes` CLI |

Adding a dependency means adding a sidecar method with its Zod schema in
`packages/contracts/src/sidecar/namespaces.ts`, a recorded fixture, and a
pytest case; the server side consumes the typed result only.

## state.db message content encoding

The server projects `state.db` read-only (`packages/server/src/sessions/state-db.ts`)
and must decode the Agent's `\x00json:`-prefixed message content the same way
the Agent writes it. The decode rules and the sentinel handling for `NaN` /
`Infinity` floats are covered by the state-db tests; writes (session start,
usage, titles, deletion) go through the sidecar so the storage format stays
Agent-owned.

Content decoding removes exactly one JSON wrapper and accepts any parsed JSON
value, including a literal string beginning with the reserved prefix. Malformed
JSON keeps its raw text. Child goal extraction uses the Agent's decoder when
available and the same rules locally for older Agents.
The public message projection converts decoded objects, numbers, and booleans
to JSON text before redaction, preserving credential-key context and the existing
client message contract.
If an integer anywhere in the payload exceeds JavaScript's safe range, the
server preserves the payload as JSON text instead of rounding it. Ordinary
multimodal arrays continue to decode as parts.

## Local reset lineage

Agent v0.22.1 local policy receipts retain a logical owner while reset and
compression move the physical transcript. The read-only state.db projection
validates those receipts before collapsing the physical rows. List and search
show the current target once, including an empty reset target, under the
existing lineage identity. Saved sidecar aliases reconcile to that target
before list deduplication, preserving the newest sidecar's UI metadata.
The common request boundary resolves old segment IDs before handlers choose
locks, runtime keys or files. Listing and materialization select the same
newest saved member for UI metadata, preserving its title, pin, archive state,
project and workspace. Display history includes compression segments since the
latest reset; model restoration uses the current physical handoff. Replay
identity still follows that reset's ancestry so carried rows keep their IDs.
Direct metadata lookups use the same projection outside the sidebar window.
List and search supplement saved aliases with a single worker batch when
their native conversation is outside that window.
Transcript reads stop at the latest reset boundary, even when a saved
Talaria record contains an older compression lineage.

Deletion resolves the whole receipt lineage on its write transaction through
the installed Agent's validator and retirement API. Invalid receipts refuse a
delete; they never authorize removal of an unrelated conversation. The sidecar
returns the committed `deleted_ids` so the server removes every matching
Talaria sidecar and its runtime artifacts, including continuations published
after deletion started. Those IDs remain available when only post-commit
artifact cleanup fails; the existing cleanup manifest can retry the artifacts.
Agents without receipts retain the legacy compression and CLI-close projection.
The shared `local-reset.json` fixture records real v0.22.1 reset/compression API
output and is consumed by both server projection and sidecar target-plan tests.

## Skill catalog identities

On Agents with the resolved skill catalog, `skills.list` uses the Agent's search
roots and precedence. Each loadable row's `name` and `load_name` are the same
canonical identifier; `declared_name`, `status`, and `tier` retain the catalog
metadata. Same-tier duplicates use exact relative paths, and shadowed or
unloadable rows are omitted. Disabled rows remain visible for management.
`skills.view` and `skills.find` use the Agent's lookup and reject ambiguous bare
names. Inspection reads the file without executing skill preprocessing.
Toggles persist the resolved identifier; enabling one copy expands an older
bare-name disable into the other copies' identifiers, including hidden copies.
Global and Web platform disables both contribute to the displayed state.
Skill content carries an `editable` capability: project, external, plugin, and
legacy flat-file skills are read-only. Save and Delete resolve the selected
local file through the same lookup and retain anchored filesystem protections;
they never mutate a shadowed local copy in place of a project skill.
Older Agents without these helpers retain the legacy list and lookup shapes.

## Session deletion

`state_db.delete_cli_session` uses the installed Agent's canonical deletion transaction
when runtime-ledger retirement is available. The Agent resolves compression segments
in both directions, receipt-backed local resets, and owned delegates; independent
branches and reset forks survive. Queued, executing or unknown ledger work and live
turn/compression guards refuse the whole operation with `refused: active_turn`.
Terminal admission and worker receipts retire with the session, retaining retry
evidence without transcript copies. The Agent's tombstones prevent late accounting
from recreating deleted sessions. Older supported Agents retain the guarded legacy
deletion path for fresh legacy sessions. If their deletion target retains canonical
runtime rows or receipts, they return `refused: runtime_history_unsupported` before
any Agent rows or transcript artifacts are removed. The HTTP server returns 409
with recovery wording before revoking shares, removing Web metadata/attachments or
journals, evicting runtimes, closing terminals, or clearing relay completions.
Recovery requires an Agent capable of retiring that history, or an explicitly
chosen pre-upgrade backup. No ledger/trigger edits or partial reset-tip deletion
are used to bypass retirement.

Talaria writes its transcript cleanup manifest inside the same database transaction,
before commit. A manifest failure rolls back deletion and retirement. File cleanup
runs only after commit and retries pending manifests on the next delete, including
after a sidecar restart. Cleanup checks surviving session IDs before removing files.
The mutated state layers are the Agent database and its transcript artifacts; the
HTTP server removes its session projection only after the sidecar's busy check.

## Toolset policy

`toolsets.catalog` discovers the scoped profile's plugins and MCP servers before resolving its
Agent toolsets, availability, and draft selection. Chat and catalog requests share MCP discovery,
including retirement of pre-multiplex launch connections.
`POST /api/toolsets` exposes that read-only catalog for Web and App with optional `session_id`
visibility checking. The `toolsets` body is the current draft or null for profile defaults. Clients
render `available`, `selected`, `unavailable_reason`, `selected_toolsets`, and `using_defaults`.
Unknown saved names remain visible as unavailable; an empty checklist cannot implicitly restore
broader defaults. Restoring defaults is an explicit action. The native app retains its previous
free-text editor only when an older Web server returns endpoint-not-found for the catalog.
Session-not-found, authentication, transport, server, and decoding failures retain the error state.

Both chat and manual compression forward the profile's parsed `agent.disabled_toolsets` to
`AIAgent`. The cached chat Agent identity includes this policy so changing it replaces the Agent
on the next turn. The Agent's filter also scopes deferred tool search and calls.
