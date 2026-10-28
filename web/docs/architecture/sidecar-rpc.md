# Sidecar RPC (TAL-245)

RPC v62 lets session-bound `commands.exec` emit the existing `clarify` and
`clarify_resolved` frames. The Agent's `bind_asker` and `clarify_asker` own choice
labels and private-value mapping. Commands reuse the chat clarification waiter
and callback without creating an Agent or chat turn. Each invocation has its
own prompt IDs, profile home, cancellation state and total 120-second budget.
`clarify.respond` accepts optional `profile_home`; command replies require it
alongside the exact session and prompt ID. Older Agents and commands without a
session retain their no-prompt behavior. Async handlers retain native fallback.
Session eviction, profile removal, credential changes and shutdown cancel these
waiters. Profile deletion waits for their handlers to return. The server withdraws
only the command's prompts on disconnect, error or completion and never replays
a handler after an unknown outcome. Turn cleanup preserves command-owned prompts.
The HTTP command path reuses the keyed concurrency budget, allowing two commands
per authenticated principal and two per profile. Excess requests receive 429
before dispatch. RPC admission permits at most eight commands globally, bounded
below the configured total call limit so replies and unrelated operations retain
capacity. Both budgets release on completion, error and cancellation.

RPC v61 adds `connectors.offer.status` and `connectors.offer.claim`. The Agent
owns connector guest eligibility, sightings, install-wide claim-once and backoff.
Status is noncreating. Only a profile-bound opaque guest identity leaves the
sidecar. The server retains each claimed page result in its document backend
until Not now or native ineligibility; OAuth uses the existing account/result
flow and keeps that result readable after the offer is withdrawn. Page refresh
uses the server interval, following the native due value. No client schedules
or signs in automatically. Older Agents report the offer unavailable.

RPC v59 adds `tts.synthesize` alongside STT. The profile-scoped Agent owns provider
registration, credentials, voice configuration and synthesis. Unknown names fail
before the Agent's implicit Edge fallback. One request owns a temporary directory
and at most 8 MiB of MP3, WAV or FLAC audio; only MP3 parts may be concatenated.
Every synthesis exit removes temporary files. `/api/tts` keeps the spoken-text
normalizer, validation, per-client limiter and `tts_unconfigured` fallback, maps
rate percentages to speed [0.5, 2], and validates but ignores pitch. Provider errors
are logged privately and returned as a generic 502. Node sends no provider request.


`plugins.catalog` reads the native reviewed catalog/cache without loading plugins, filters and
orders it on the sidecar, and returns at most 50 rows per page. Installer-owned metadata supplies
the installed key and revision. `plugins.install` accepts only a catalog name and an optional
single-use confirmation token. It uses the native catalog installer staging hook to preview and
bind the profile, full catalog entry, staged bytes, requirements and scan. Publication remains
Agent-owned with force and dependency consent disabled. No enable, host capability grant or
sidecar-proxy permission is performed. Changed or expired evidence requires a new preview.
The HTTP write is owner-only and never retries an unknown outcome; clients refresh catalog and
installed rows. Older Agents without the staging boundary report the catalog unsupported.

The TypeScript server never imports Hermes Agent code. Everything that needs
Agent Python modules runs in one Web-owned sidecar process,
`python -m talaria_sidecar`, spawned on the Agent's own venv interpreter with
`PYTHONPATH=<agent dir>`. The sidecar is stdlib-only Python; it has no pip
dependencies of its own and installs nothing.

The server sets `HERMES_DISABLE_LAZY_INSTALLS=1` for the sidecar and launcher
preflight. The sidecar also sets it at package import for direct Python entry
points. Importing Agent modules cannot adopt a checkout, sync dependencies, or
re-exec through the Agent's lazy-install path, which would lose the RPC file
descriptor and the sidecar's `PYTHONPATH`. Explicit Agent updates own dependency
sync before restarting either process. Live `runtime.env` edits preserve the
opt-out as well.

RPC v19 adds `runtime.sync_dependencies`. It validates the requested checkout
against the sidecar's configured Agent directory and runs `hermes_cli.venv_sync`
in a subprocess on that sidecar's interpreter and launch environment. It remains
available when Agent imports fail or the loaded revision is stale, since those
are the states an explicit update must repair. The server owns the durable
pending-sync marker and restart ordering; it never launches Agent sync itself.
The sync supervisor holds an OS lock per launch home and checkout until its
writer exits. Its stdin pipe belongs to the sidecar: cancellation, shutdown, or
the sidecar being killed closes that pipe, so the supervisor stops the
writer's process tree and reaps the writer before releasing the lock. A concurrent repair fails
without starting another writer.

RPC v58 adds profile-scoped declared MCP cost-policy inspection. It retains the
reaction boundary introduced in v57; a v57 peer is rejected before Agent loading.

RPC v57 adds the closed `gateway.session` reaction action and safe message reaction metadata.
It retains v56's managed buffers, v55's captured commands and outbound draft review, plus v54's checkpoint read
below. Reaction-only watch snapshots invalidate display data without settling a turn; writes
use the authenticated owner and uncertain outcomes are read back.

RPC v55 adds closed `gateway.session` actions `terminal_info` and `shell_exec`.
They require a verified native owner boot revision supporting captured commands.
`terminal_info` observes the target without executing; `shell_exec` fences the
observed authority/replay identity and forwards only session id and command to
native `shell.exec`. The owner authorizes its frozen local backend and cwd,
refuses unsafe commands, strips managed secrets, and redacts before bounding
stdout/stderr to 4000/2000 characters. The captured result includes the exit code.
No transcript/admission is written, no host shell fallback exists, and unknown
acknowledgments are never retried.

RPC v54 adds the read-only `gateway.session` action `checkpoint_diff`. It calls the authenticated
owner's `rollback.session_diff` without resuming or subscribing, so compression/restart and the
frozen checkpoint/terminal policy remain owner decisions. No host checkpoint manager or native
restore is used. The optional `rollback.list` read distinguishes an empty diff from no retained
baseline. The diff and stat together must fit 4 MiB of JSON-escaped UTF-8 content. The result's
`comparison` declares native provenance, the earliest retained **project** baseline, availability,
refusal reason and native line truncation. This baseline can predate the chat, or follow its start
after pruning. It is not a per-session edit ledger. Direct workspace diffs retain their selected
checkpoint baseline. The existing rollback HTTP list adds `session_diff` for native targets;
its empty workspace field does not authorize host filesystem access. Diff reads use the same
server parser and the existing Checkpoints dialog. Native restore remains refused.

RPC v53 adds the closed `gateway.session` action `export` with `json`, `markdown`
or `html` and a server-selected `redact` policy. It calls the already-running
profile owner's read-only `session.export` once, translating Markdown to native
`md`. The owner selects its current physical transcript after reset/compression.
No resume, subscription, local session, Agent-host file or gateway launch is
created. The native request has a 25-second RPC deadline and a 30-second outer
deadline; content is capped at 4 MiB UTF-8 at both sidecar and HTTP boundaries.
The server supplies Talaria's redaction policy to the owner, which redacts before
rendering. JSON and Markdown also receive Talaria's text redaction; rendered HTML
stays intact. Talaria owns the download filename and MIME type.
Older/unavailable owners refuse export with an actionable HTTP 409; size
refusals return 413. Direct session exports retain their existing renderer.

## Pending steer delivery

`chat.steer_now` reports `reason: not_running` only when its run or Agent is
absent. A live Agent that cannot redirect between requests puts the hint back
in its pending slot. The server maps that result to `next_step` at
`POST /api/chat/steer/send-now`; `delivered`, `not_running`, `taken`, and
`failed` distinguish the other exits. Both clients render this server outcome
through their existing notices. `redirected` remains for older clients, and
new clients retain their previous boolean fallback for older servers. Remove
the boolean and its fallbacks once those supported versions all use `outcome`.

## Ownership

Failed Agent updates are continued by `UpdateService` in the running server.
It starts recovery at startup and after an update releases its lease, regardless
of update-check preferences and subscribes to validated sidecar reconnects.
One sequence owns its timer, cancellation signal, handshake subscription and
`runtime.agent_recovery` calls. Six failed attempts use bounded backoff. Waiting
for active Web work uses a positive delay without spending that budget. So does
a `draining` result: recorded gateway writers still finishing an acknowledged
native drain within its profile's bounded native drain budget, counted from the recorded
acknowledgement (or first observation for older custody). A drain past that
budget, an unacknowledged or cancelled drain, and every identity or
configuration refusal still spend the budget. Exhausted debt stays blocked with
the actual failure and keeps a lightweight probe. The probe's fingerprint
covers the retained receipts and their watched source and interpreter paths. It
also covers each retained gateway's `gateway.pid` stamp and stdlib presence of
its recorded processes. A change in that fingerprint, a healthy runtime
reconnect, or the update lifecycle rearms the sequence. A changed fingerprint
only triggers revalidation and never discharges debt. While a step waits out a
drain, it adopts a verified successor through the same readiness check once
the recorded writers exit; it never asks that successor to drain.
An interrupted recovery notice loses its active state at startup, then reaches
verified completion only after the coordinator checks current loaded readiness.

`runtime.agent_recovery` probes the configured checkout's native pause records
and claims, supervised companion, native repair receipts and Web dependency
intent. A recovery step takes the existing gateway action lock and native
checkout lease. It resolves the current interpreter, continues the native
recorded source repair, verifies the recorded baseline/target and source tree,
repairs owed dependencies and resumes the exact recorded services. Pending
private autostashes return to the server's existing leased local-edit restore
path before services resume. Unknown receipts and foreign or unprovable process
identities stay blocked. Recovery never selects a release or replays legacy
interruption consent.

Source repair reads the native launch-repair procedure from the receipt's
immutable baseline and uses its verified recovery closure before importing
checkout modules. This also covers a torn recovery module. Invalid receipts
remain in place. A failed source move carries recorded rollback intent, so a
partially landed target can return to its baseline without selecting a release.

After native debt is discharged, the server verifies `runtime.status` and
`runtime.ensure_current`. A changed runtime is recycled through the normal
interpreter resolver once active Web work drains. An unchanged valid runtime
stays loaded. Provider readiness caches are invalidated after verification.
The existing companion and Web repair intent remain durable until
`runtime.agent_recovery` acknowledges the exact loaded revision under the native
lease. An old or mismatched acknowledgement cannot discharge that debt.
The update status's optional `agent_recovery` projection and the shared
notification store expose running, waiting, blocked and complete recovery.
Recovery does not overwrite the initiating update's result or claim that the
requested revision was installed.

| Concern | Owner |
|---|---|
| Tested Agent identity (`sidecar/agent_dependency.json`), drift guard, loaded-revision check | sidecar |
| RPC method schemas, versioning, fixtures | `@maudecode/talaria-web-contracts` (`sidecar/` schema group) |
| Spawn, restart on crash, fail-closed 503 while unavailable | server |
| WebUI-owned files (sessions, settings, journals, auth, shares, drafts) | server only |
| Agent-owned files and `state.db` writes | sidecar, through Agent modules |
| `state.db` read-only projections | server (`better-sqlite3`) |

Coupling chain, one pin per arrow:
Agent ← sidecar (`agent_dependency.json`) ← server (RPC version in the contracts
package) ← iOS app (`contracts/web-api.openapi.json`, `contracts/versions.json`).

## Transport

Newline-delimited JSON-RPC 2.0 over the sidecar's stdin/stdout. stderr is the
sidecar's log and is forwarded to the server log with a `[sidecar]` prefix.
At startup the sidecar keeps a private duplicate of fd 1 for RPC frames and
redirects both `sys.stdout` and fd 1 to stderr, so Agent code that prints
(profile deletion, pip output, warnings) can never corrupt the channel.

- Request: `{"jsonrpc":"2.0","id":<int>,"method":"<ns>.<name>","params":{...}}`
- Result: `{"jsonrpc":"2.0","id":<int>,"result":{...}}`
- Error: `{"jsonrpc":"2.0","id":<int>,"error":{"code":<int>,"message":"...","data":{...}}}`
- Stream frame (sidecar to server, for long-running calls):
  `{"jsonrpc":"2.0","method":"stream","params":{"id":<request id>,"seq":<int>,"event":"<name>","data":{...}}}`

- Server-originated notification (no id): `{"jsonrpc":"2.0","method":"<ns>.<name>","params":{...}}`
- Cancellation is a separate request: `rpc.cancel` with `{"id":<request id>}`.
  The cancelled call still completes with a result whose `status` is
  `"cancelled"`, so the server never waits on a dangling id.

`chat.start` emits its first token immediately, then coalesces consecutive token
deltas within 16 ms before taking usage/steer snapshots and writing a frame.
The next token after that interval, any non-token event, or turn exit flushes
the buffered text in order. There is no timer: a quiet tail waits for the next
event or turn exit. Each turn owns its buffer; success, cancellation and errors
flush it before the RPC response. Token frame shapes and final text are unchanged.

One line per message; every line is a complete JSON document with no embedded
newlines. Binary payloads (audio for STT, images) are base64 fields.

Error codes: the JSON-RPC reserved range for transport problems, and
application errors in `-32000..-32099`, one per error condition
(`agent_runtime_stale`, `agent_incompatible`,
`profile_fail_closed`, `credential_missing`, `interrupted`, `timeout`). The
`data.condition` string is the value the server forwards to HTTP clients.

## Lifecycle

1. Server discovers the Agent directory and venv with the same rules as today
   (`HERMES_WEBUI_AGENT_DIR`, `$HERMES_HOME/hermes-agent`, sibling checkout,
   `~/hermes-agent`, `/opt/hermes`, `/usr/local/lib/hermes-agent`, then the `hermes`
   launcher on `PATH`, including unquoted `exec` wrappers). Interpreter precedence:
   `HERMES_WEBUI_PYTHON`, the PM generation recorded in
   `<hermes-root>/installs/<sha256(realpath(agent))[:16]>/facts.json`, then
   `<agent>/venv` or `<agent>/.venv` when no PM selection exists. Named profiles
   share their root's records. A PM selection must resolve inside that install's
   `environments/` and contain `pyvenv.cfg` and a Python interpreter; a broken
   selection is rejected without falling back to older dependencies. An explicit
   `HERMES_WEBUI_PYTHON` that differs from the PM selection still wins, with one
   launch warning; the handshake reports `agent_incompatible` when `sys.path`
   holds site-packages built for another Python version.
   Bootstrap preserves user-supplied interpreter overrides but does not export
   auto-discovered paths as overrides, so restarted workers read the current PM selection.
2. Server spawns the sidecar and sends `runtime.handshake` with
   `{rpc_version, hermes_home, state_dir}`.
3. Sidecar uses the Agent's `pm.store_first_path` when available to
   expose installed tool binaries before importing `run_agent` (no packages are
   provisioned by this PATH step), reads its own `agent_dependency.json`, and replies
   `{rpc_version, agent_revision, pinned_revision, compatible, stale, python, agent_dir, capabilities}`.
   A `rpc_version` mismatch is a fatal handshake error; the sidecar exits 3.
4. `compatible` means Agent imports succeeded; it does not mean the installed revision equals the tested pin.
   The server warns when the loaded revision differs. Agent calls remain available while the imported runtime
   is current, with individual methods checking their required capabilities and profile credential isolation.
   A failed Agent import blocks Agent methods but allows `config.get` and `config.set` after a valid RPC handshake,
   so SSO and authorized config repair remain available. A protocol mismatch still blocks all methods.
   A stale loaded runtime blocks Agent methods with `agent_runtime_stale`.
5. On sidecar exit the server restarts it with exponential backoff (1 s, 2 s,
   4 s, capped at 30 s). Each spawn re-resolves the interpreter, so a replaced PM
   generation is picked up without a Web-worker restart. An unavailable selection
   stays unavailable and retries discovery on the same backoff schedule, including
   initial startup when a checkout exists but its interpreter is not yet available.
   Every in-flight request fails with
   `sidecar_unavailable`. Session-scoped agent caches are lost.
6. The drift guard runs inside the sidecar on every chat turn: if the Agent
   checkout revision or update markers changed since import, the call fails
   with `agent_runtime_stale` and the sidecar refuses further chat calls until
   restarted.

Recovery admission checks fixed markers and discovered receipt presence on every
call. Each runtime caches only the native-claim and pending-autostash directory
listings and packed-ref inspection for at most one monotonic second. File and
directory metadata invalidate discovery immediately; missing paths watch their
nearest existing ancestor. Recovery probes and repair operations scan uncached.
This does not add detection of dirty tracked files to the revision-drift guard.

One sidecar per server. Each admitted RPC runs on a worker thread, bounded by
the transport's call limit. Cancellation reaches an active call without taking
another slot. A session has at most one chat run at a time; command waiters have
independent invocation identities.

Provider-plugin listings retain the scoped home's manifest enable/disable gate. With
`plugins.isolation: host`, the sidecar maps enabled plugin directories through the
Agent's cached hosted-profile metadata and selects providers from its per-home
user registry. Provider ids may differ from manifest names. In-process and older
Agents retain module ownership checks, so another profile's plugins stay hidden.
Hosted ids claimed by multiple directories remain `not_loaded`, including collisions
with disabled or manifest-less plugins. Their model catalogs remain empty.
Explicit provider runtime requests use the same ownership check before Agent
resolution in both `providers.resolve_runtime` and the shared chat/auxiliary
resolver. A foreign, disabled, ambiguous or unverifiable plugin returns
`credential_missing`; a process-wide Agent registry cannot authorize its execution
in another profile. Built-in providers and requests without a provider retain the
Agent's normal resolution.

`plugins.isolation` reads each profile's `plugins.isolation` and counts the plugin
directories under its `plugins/` without loading them; the server's `/api/plugins`
derives `plugin_isolation_advisory` from those rows.

## Method namespaces

Every method has a Zod schema for params, result, and stream events in the
contracts package (`packages/contracts/src/sidecar/namespaces.ts`). The Python
suite validates real results against the JSON Schema export of those
definitions (`sidecar/tests/fixtures/schemas.json`); `sidecar/scripts/record-fixtures.py`
records real responses into `packages/contracts/fixtures/sidecar/<namespace>.json`,
which the Vitest fixture test validates and `FakeSidecar` answers from.

Every method takes the explicit `profile_home` (or `base_home`) the server
resolved; the sidecar never reads the active-profile cookie or file. Calls run
under Hermes Agent's context-local home override (`talaria_sidecar/home.py`).
The sidecar memoizes the Agent-built secret and terminal scopes for at most 64
recently used homes. Each call checks `.env` and `config.yaml` file identities,
timestamps, sizes and modes; cache hits recheck that stamp under the cache lock,
and changed files rebuild the scopes. Secret snapshots
also track external-source values, managed credentials and launch policy inputs.
Bindings receive private copies. Uncertain file stats and raised build failures
are not memoized; terminal-policy failures retain the Agent's refusal scope. Older Agents without
the cache input APIs retain their original uncached behavior.

| Namespace | Methods | Streams |
|---|---|---|
| `rpc` | `cancel`, `methods` | |
| `runtime` | `handshake`, `status`, `ensure_current`, `shutdown` | |
| `goals` | `get`, `command`, `snapshot`, `restore`, `evaluate` | |
| `commands` | `registry`, `exec`, `expand_prompt`, `bundles`, `bundle_resolve`, `moa_preset` | |
| `plugins` | `providers`, `list`, `settings`, `settings_save` | |
| `kanban` | `board`, `boards`, `create_board`, `update_board`, `delete_board`, `switch_board`, `task`, `create_task`, `patch_task`, `task_action`, `comment`, `link`, `unlink`, `events`, `config`, `stats`, `assignees`, `task_log`, `bulk`, `dispatch` | |
| `state_db` | `sync_start`, `sync_usage`, `sync_title`, `delete_cli_session`, `append_message` | |
| `profiles` | `list`, `create`, `delete`, `runtime_env`, `skills_stats` | |
| `skills` | `list`, `view`, `find` | |
| `mcp` | `status`, `registry_tools`, `reload` | |
| `connectors` | `available`, `catalog`, `accounts`, `remove`, `tools`, `policy.get`, `policy.set`, `connect`, `operation`, `respond` | |
| `stt` | `capability`, `transcribe` | |
| `cron` | `list`, `get`, `create`, `update`, `delete`, `pause`, `resume`, `run`, `status`, `history`, `run_detail`, `output`, `delivery_options` | `run`: `started` |
| `providers` | `registry`, `auth_status`, `model_ids`, `resolve_runtime`, `credential_pool` | |
| `oauth` | `start`, `poll`, `cancel` | |
| `models` | `context_length`, `estimate_tokens`, `capabilities`, `reasoning_efforts`, `speed_tiers` | |
| `aux` | `complete`, `resolve` | `complete`: `token` |
| `text` | `image_mode`, `portal_tags` | |
| `process` | `drain`, `recover`, `requeue`, `mark_consumed`, `consumed`, `format_notification`, `list` | |
| `usage` | `account`, `pool`, `pool_providers`, `balance` | |
| `gateway` | `control`, `restart` | `control`, `restart`: `progress` |
| `chat` | `start`, `interrupt`, `steer`, `evict_agent`, `finalize_session` | `start`: `token`, `reasoning`, `interim_assistant`, `tool`, `tool_progress`, `tool_complete`, `approval`, `clarify`, `clarify_resolved`, `compressing`, `compression_finished`, `warning`, `status`, `context_status`, `notice`, `notice_clear`, `notices_reset`, `rate_limit_wait`; the settled transcript, usage, and terminal status come back as the result |
| `approval`, `clarify` | `approval.pending`, `approval.respond`, `approval.set_yolo`, `clarify.respond` | |
| `worktree` | `create` | |
| `checkpoints` | `list`, `diff`, `restore` | |
| `memory` | `check`, `write` | |
| `write_approval` | `pending`, `approve`, `reject` | |
| `config` | `get`, `set`, `env_write` | |

Session title calls resolve the session's model and provider through chat's
catalog repair, then pass that pair as `main_runtime` with `main_fallback: true`.
A dedicated title model takes precedence; Auto
resolves against that session runtime. If no auxiliary client answers, the
sidecar tries the session model through a disposable, tool-free Agent before
the server uses its local title summary. These calls use the sidecar's default
timeout, like commit-message generation.

Chat lifecycle diagnostics beginning with ⚠ or ❌ emit `warning` frames regardless
of their wording. Compression notices retain their existing classification, and
non-retryable errors retain `status` with `kind: terminal_error`; they also warn
when announcing a fallback. These diagnostic frames do not terminate a turn.

What stays in the server, by design: WebUI files, `config.yaml` / `.env`
policy, MCP config edits and HTTP/stdio health probes, skill file writes,
kanban query parsing and the SSE poll loop, cron cross-profile merging and
running-state display, provider catalog composition and caches, dashboard
plugin manifests, `state.db` read-only projections.

`.env` edits go through `config.env_write`, which applies them with the Agent's
own `.env` line helpers under the `<.env>.lock` its `save_env_value` /
`remove_env_value` take, so a concurrent Agent write never drops a Web-saved
key. Unlike those two it never publishes into the sidecar's `os.environ`;
`runtime.env` alone owns that. The server still reads `.env` directly.

For `cron.create` targeting another profile, the sidecar resolves that execution
profile's main model before writing to that profile's own cron store. It fills
empty caller model/provider fields with ordinary per-job pins. The Agent
scheduler binds credentials, configuration, skills and terminal policy to the
physical store home; it does not interpret Talaria's `profile` field or legacy
snapshot keys. A profile without a main model returns `cron_snapshot_failed`
before any job is created. An explicit model and provider, or a script-only
`no_agent` job, skips model resolution but still uses the execution store.

New Agent records retain the creating Web profile in additive `owner_profile`
metadata. The server uses it to keep those jobs in the creator's list and route
edit, pause, resume, delete, manual run, output, history and recent-completion
lookups to the execution store. The HTTP `owner_profile` field names the
physical store profile, and `read_only` is computed by the server. Hidden
inactive profiles and profiles outside an isolated instance are not searched.
Ambiguous managed IDs are refused rather than routed to an arbitrary store.

Changing a job's profile requires duplicating it in the new profile and deleting
the old task; editing must not create a profile/store mismatch. Clearing the
stored profile override keeps the physical execution home, which the server
reports explicitly. Context references must resolve in that same home. Existing
records are not migrated automatically. Legacy jobs without creator metadata
remain available to their store profile; a legacy execution/store mismatch must
be recreated before Web can manually run or resume it. Pause and delete remain
available. The Agent's existing scheduled records are unchanged until the user
recreates them.

Manual agent-backed runs on Agents with canonical cron ownership allocate the
Agent execution-ledger identity before spawning their submitter. Cancellation,
timeout and fire-claim loss share a multiprocessing cancellation event. The
submitter passes that event and identity to `run_job`; a cancellation ACK is
never treated as terminal proof. A lost submitter uses `cron.recover` with the
original job/request identity, then only `cron.cancel` and `cron.status` with
that admission's receipt. Recovery observes a ready gateway and never starts one.

The additive `cron/manual_runs/<job-id>.json` record preserves cancellation
intent and bookkeeping ownership. A runnable schedule is paused before dispatch
so a crashed sidecar cannot let its expiring claim start another run. Only that
exact pause is lifted after settlement; operator pauses and successor claims
are never overwritten. Unverified outcomes retain the record, pause and running
projection and return `cron_execution_unverified`, rather than reporting a
cancelled task. An explicit sidecar `cron.run` for a retained record reconciles
that execution and never submits a replacement. An unknown owner admission
requires owner-side recovery before it can settle.

Resume, edits and deletion share the manual-run lock and reject retained
executions, so schedule controls cannot remove the recovery barrier. Recovery
loads its persisted job snapshot even if another Agent process removed the job.
It also recovers a missing pause receipt from the execution-specific pause
reason, including a crash between the schedule write and the receipt write.
The live `cron.status` registry contains only active calls, so a retained
obligation cannot block Web's retry preflight. List/get project retained job
snapshots when the Agent record was removed, preserving profile ownership and
the existing Web lookup path without recreating the scheduled job.
The internal `recovery_only` flag excludes retained snapshots from new task
context choices and validation. The server strips it from public job views.

The Agent's output/delivery and owner-fenced bookkeeping helpers own the
terminal tail. Before those side effects, Web persists an at-most-once barrier
and retires the Agent's generic orphan journal, preventing two recovery paths
from replaying it. An interrupted tail without a durable completion receipt
stays unverified for operator reconciliation; it never repeats delivery or
bookkeeping. Older Agents and script-only jobs retain process-group stopping.

Chat turns use the Agent's in-process callback model inside the sidecar:
`AIAgent` is constructed with signature-gated
kwargs, callbacks translate to stream frames, `interrupt()` is `chat.interrupt`,
approvals and clarify prompts raised by tools block inside the sidecar until
the server answers with `approval.respond` / `clarify.respond`, and the
per-session agent cache lives in the sidecar. An agent that leaves the cache
(LRU trim, a model or credential change, `chat.evict_agent`, shutdown or stdin
close) ends its memory session with its transcript and releases its LLM clients
under its profile, once no turn still holds it. Shutdown stops running turns
and waits up to 4 s for those releases.

`approval.respond` grants only the selected request's patterns, or the oldest
request when no ID is supplied. Always saves only unsaved grants relative to
the active profile's Agent allowlist baseline. A cached standing approval can
therefore never become a new grant after an operator revokes it. Retained Agents
with a full-snapshot native choice writer use this sidecar path; an Agent without
the profile-scoped baseline APIs is refused before granting Always. Disk writes
remain best effort, as in the Agent: a failed save leaves the explicit grant in
memory and resolves the request, and a later successful save includes it.

Clear and delete call `chat.finalize_session` with the owning `profile_home`,
`session_id`, and `reason` (`clear` or `delete`). Clear finalizes before removing
the transcript. Delete finalizes only after the local session deletion commits,
so Agent refusals and failed share, relay, or storage cleanup do not close a
conversation that remains present. Repeated deletes skip finalization.
It runs the Agent's `finalize_session` with platform `webui` under that profile,
waiting at most 10 seconds. Missing lifecycle helpers, failed hooks, and timeouts
return no messages and never prevent the requested boundary. A timed-out worker
keeps its own profile scope until it finishes; profile deletion waits for it as
it does for memory releases. Cache eviction alone does not finalize a session.
Clear persists returned text as `local_notice` rows with `_notice_kind:
session_finalize`; the shared model-history sanitizer excludes these rows,
including after reload, duplicate, or branch. Delete discards the text.
Read-only and subagent sessions retain their existing mutation refusals.

Agent v0.21.6 clarify callbacks receive a normalized question list. The sidecar
emits it in the existing batch frame, and the server returns a validated keyed
answer envelope. The callback returns `answers` and `outcome` to the Agent:
`submitted`, `cancelled`, or `timed_out`. Cancellation and timeout contain no
fabricated answer. The two older supported Agent releases retain their legacy
callback and result shapes until the support window drops them.

The Agent's password-manager prompts (master password, a login to save, a
one-time code) are per-thread callbacks the sidecar binds on the turn's thread,
with the session an unlock belongs to, and clears when the turn ends. The
unlock prompt binds that session again on the thread that calls it, since the
Agent copies the callbacks, not the session, onto its tool workers. Each
parks like a clarify prompt with a `vault_*` `kind` and the Agent's own timeout
(120 s to unlock, 180 s otherwise); an empty `clarify.respond` answer is its
decline. Ending a session (`chat.evict_agent` with `clear_session`) locks the
password managers that session unlocked. A turn that outlives its session's end
releases them again when it finishes, so an unlock answered after the end
does not stay open.

Each turn agent holds a reference to its profile's `state.db` from the Agent's
shared-handle registry (released with the agent), keyed by the Web session id,
so the Agent writes each turn's rows there like any other surface. A new agent
for a session the Agent already rotated by compression starts on the live
compression tip with the server's history. The server records the session's
compression lineage (`state_db_lineage`) when a turn settles. It reads
state.db rows across that lineage and covers the rows the continuation
restated at rotation. Deleting the session deletes the whole lineage, tip
first. A `/btw` side question
(`ephemeral: true`) gets no handle, so its throwaway session never reaches
`state.db`.

A spoken turn (`voice_turn: true`, sent by the App for a voice note) sets the
Agent's `_voice_turn_pending` mark, and every other turn clears it. The Agent
then runs that one turn on the profile's `auxiliary.voice_chat` slot and
records its usage under `voice_chat`; with no slot configured it stays on the
main model. Agents without `agent.voice_turn_route` are left untouched.

Manual `/compress` is `chat.compress`: a throwaway `AIAgent` runs the Agent's
shared `compress_now` core over the history the server sends and returns the
compressed messages and summary without persisting anything. The server
re-checks the session under its lock (a stream that started or a transcript
that changed during the call is a 409) before it installs the result as the
model context, so the browser job and the iOS route share one worker. The
Agent's context-engine notification is two-phase: a compressed result carries a
`commit_token`, and the server answers `chat.compress_finalize` with whether it
installed the result (an unanswered token is discarded after ten minutes).

The same job compacts an over-threshold session before its next turn (TAL-1005).
`chat.start`'s `context` reports `next_turn_threshold_tokens`, the threshold the
next turn runs under: the primary runtime's when a fallback ran this turn, since
the Agent restores the primary at the next turn's start. A turn that settles with
its context at or above that threshold starts the job in the background. A new
turn joins a running job, or starts one when the session is over the threshold
and the turn keeps the same model, and waits on it before it reads its history.
Its stream shows `compressing` meanwhile. A Stop during that wait ends only the
turn; the job keeps running, and the next send joins it. The commit accepts the
rows waiting turns added meanwhile (their prompts and Stops) and keeps them after
the compressed context. A failed, `lock_skipped`, or `nothing_to_do` job leaves
the turn to the Agent's own preflight compression.

Provider sign-in is `oauth.*` (TAL-398). `oauth.start` runs the Agent's own
device-code request for Nous Portal, OpenAI Codex, xAI, or MiniMax under the
profile home and returns the code to show. A sidecar thread waits for the
approval and saves the credential with the Agent's auth-store helpers under that
home. A flow belongs to the home that started it. After a cancel or an expiry,
nothing is saved, and a new start for the same home and provider supersedes the
pending one. Flows live only in the sidecar process.

Background processes survive a sidecar restart through the Agent's
`processes.json` checkpoint (TAL-533). The Agent owns the process registry and
each home's checkpoint. The registry is process-global, and a spawn rewrites
the active home's checkpoint from it. So the server's completion drain calls
`process.recover` with its base home once per sidecar handshake, before its
first `process.drain`, and retries it on every pass until it succeeds, logging
the failure once per sidecar. The sidecar enters the base home and every
`profiles/*` home under it, and entering a home's scope (`scoped_home`) runs
`process_registry.recover_from_checkpoint()` there until it succeeds once per
sidecar process, so a home first used later is still recovered before any call
in it can spawn. Recovery fails closed: when it raises, or the checkpoint is
unreadable or not a JSON list (which the Agent would read as empty), the call
that entered the home fails, and so does every later call in that home until a
retry succeeds. No call can spawn and overwrite a checkpoint the Agent could
not re- adopt. `process.recover` still tries every home and then reports the
failures. The sidecar and the server each log a lasting failure once. Recovery
adopts only a live PID whose recorded start time still matches, and it restores
the `session_key` (the WebUI session id) that the server routes completions and
Background rows by, so no server index is rebuilt. An adopted process has no
reader thread: `process.drain` probes it on every pass, so a process in a
profile nobody has used since the restart still reports its exit. That
completion has an unknown exit code and no output history. A process that
exited while no sidecar was running is not adopted and reports nothing.
The server drains every second while passes route events. Each pass that routes
nothing doubles the delay, up to 10 s. A turn start or a tool call that starts
background work drains on the next tick and resets the delay (TAL-1395).

Durable async-delegation results use a separate replay path (TAL-780). Before
popping events, `process.drain` calls the Agent's `restore_completions()` when
available, which restores the launch ledger once. It also restores each named
profile's ledger once under `scoped_home` and calls the Agent's throttled orphan
sweep for every served home. `process.recover` supplies the base home; each drain
re-enumerates its contained named profiles so inactive and newly created profiles
are covered even though the server drains only one global queue. A failed named
replay is retried without blocking the other homes or live queued events. Older
Agents keep their existing import-time replay. Restored events retain their
session ownership, and delivery still uses the Agent's claim/complete/release
ledger calls; the server requeues events it cannot route to their owner.

A subagent's own process notices (TAL-933) reach the parent session only when
the session's profile sets `delegation.surface_child_process_notifications:
true`, as in the Agent's CLI, gateway and TUI. `process.drain` marks each such
event `child_process` with the Agent's `is_child_process_notification` (the same
rule inline on Agents before 0.21.7); the server reads the owning profile's
config and otherwise drops the event without a wakeup. It does not mark the
exit consumed, so an exit nobody read still reaches the parent through the
child's `unread_completions`. Async delegation results are never child notices.

## Process heartbeat progress

Process heartbeat events are progress. The server keeps their receipt running with the latest
output and wakes the owning session with the Agent's `process.format_notification` text, deferred
while a turn is active. Each heartbeat has its own delivery identity and consumes no process exit.
Heartbeat-only prompts persist with `display_kind: hidden`; clients receive `_display: hidden`.
Meaningful agent replies and batches containing completions remain visible. Heartbeats emit neither
`bg_task_complete` nor `process_complete`. Agents without heartbeat support return empty formatter text.

## Deliberate archive notification

RPC v49 extends `chat.finalize_session` with `reason=archive` and optional `lineage` IDs.
Unlike clear/delete finalization, this branch only calls the installed Agent's
`emit_session_deleted` with `reason=archive`, the logical primary ID and the persisted
local conversation lineage. The emitter receives a path-only database identity for the
owning profile; notification never opens or writes `state.db`, closes the session or
clears approvals. Agents without the emitter do nothing.

The server dispatches once under the shared archive mutation lock, after an unarchived
to archived local save commits. Same-state requests, unarchive and cleanup do not dispatch.
The transition uses persisted before/after archive metadata; a refused save reports a conflict
without notifying. Delivery is best effort, with no retry after a committed archive. Archive
RPC replies acknowledge worker scheduling immediately, so bulk actions do not serialize slow
plugin callbacks. Archive work shares at most four daemon workers and a queue of 256 pending
callbacks. Queued and running items use the existing release roster to retain profile custody
until completion; profile deletion and shutdown fence new admission. A full queue drops the new
best-effort notification with a payload-free warning, without undoing or retrying the archive.
Archive callback diagnostics expose one payload-free warning instead of raw exceptions.

## Versioning

`rpc_version` is an integer in the contracts package
(`SIDECAR_RPC_VERSION`). Any change to a method's params, result, or stream
frames bumps it. The sidecar refuses to start on a mismatch. Both the fake
sidecar and the real one are tested against the same fixtures, so a drift
between them is a failing test, not a runtime surprise.

RPC v56 adds `plugins.buffers`, the fixed, profile-scoped managed-buffer adapter.
Peers using RPC v54 or v55 fail the handshake before the new source can be used.
The [managed-buffer contract](../CONTRACTS.md#managed-session-buffers) defines its
bounds, permissions and unconditional native write semantics.

The read-only HTTP `POST /api/crons/context-sources` projects eligible context
choices from accessible, managed jobs in the editor's execution store. The server
excludes the edited/source job and marks ineligible selected references
`selectable: false` so the client can offer removal without offering them again.
The Web form renders these explicit choices and does not filter its global job
list to infer eligibility. This is a server projection, with no new sidecar RPC.

`models.speed_tiers` batches model/provider/base-URL routes through the Agent's
`resolve_fast_mode_overrides`. Its tier rows carry the tier identity and the
`service_tier` value to persist. Anthropic Fast saves `priority` but sends
`speed: fast`; Ultrafast is offered only when the resolver supports that exact
tier. Agents with the older resolver signature offer Fast only. Without a
resolver, the legacy GPT-5/o-series gate applies only on first-party OpenAI
routes. Failed lookups offer no paid tiers and block writes that would otherwise
erase a saved tier. Chat uses the same helper against its resolved runtime URL.

### Parent admission for transcript-only delegation deliveries

RPC v38 introduces these completion claim and reconciliation semantics. Both
protocol constants and the recorded runtime fixture advance together, so a v37
server cannot connect and replay delivered results without admission receipts.

The Agent can persist an `async_delegation_complete` notification and acknowledge
its global ledger without starting the Web parent. `process.drain` reconciles
these typed deliveries across the same contained profile homes as pending replay.
It requires a delivered final ledger event, a matching notification in the exact
parent's compression lineage, and a delivery within the Agent replay window.
The bounded scan advances a separate cursor per profile and wraps after the final
page, so accepted rows cannot starve later deliveries. Interim notices, presentation
suppression, unrelated transcripts, pending claims,
and arbitrary delivered ledger rows do not qualify. Reconciliation reads Agent
SQLite state only; it never resets a delivered flag or runs a child again.

Candidates use the normal completion queue, routing, deferral and turn admission.
Their `reconciliation_profile_home` must match the Web session's owning home.
`process.claim_delivery` rechecks the typed proof at admission and returns an
empty claim for these already globally delivered results. A pending claim owned
by another consumer returns `retryable: true`, retaining the Web wakeup.

Web stores `completion_acceptances` in the owning session, keyed by canonical
profile home and delegation ID. Each value is the admitted stream ID, written in
the same atomic save as the pending prompt, before the worker starts. The drain
checks these durable receipts before replay; a legacy Web prompt with an exact
matching body, `process_wakeup` source and turn ID also proves admission.
Delegation payloads enter the in-memory deferred queue before persistence. A failed
held-file write or session save retains that entry and schedules the existing retry
timer, so a live result does not depend on an Agent orphan sweep. Payloads extend
the existing `_wakeup_held.json` mechanism across busy,
Stop, sealed-snapshot and provider-pause deferrals. Deleted sessions discard their
held payloads. Stop's `automatic_turns_stop_held` session metadata survives restart
and clears when the user's next turn is admitted. A failed hold write keeps the
in-memory Stop hold and still interrupts the Agent. Existing Stable readers ignore
the additive metadata. Both instances share one Web server's per-session drain
serialization; this does not introduce multi-server shared-state support.

The existing background-update projection uses the structured delegation event
to render an unknown result as a notice needing attention. A typed Agent row's
`completed_count` alone is not evidence of success.

RPC v39 extends the existing session-delete refusal enum with
`runtime_history_unsupported`. Older Agents may open state written by a newer
Agent, but cannot retire its canonical runtime history or local-reset receipts.
The guarded legacy path detects that retained state inside its write transaction
and refuses without deleting rows or artifacts. Single and bulk HTTP deletion
return the same actionable conflict before Web cleanup.

`models.selection_warnings` evaluates the profile's Agent selection guard registry
without mutating the session or evicting its Agent. It receives current and target
model/provider identities and measured context, falling back to the profile's
cached Agent and then its read-only persisted usage anchor. A provider change
cannot count as a same-model cache-preserving selection. RPC version 42 adds this
method; version 41 peers fail the handshake before attempting it.

## Provider balance credentials

RPC v43 adds scoped environment names, key presence, and opaque credential
revisions to usage reads;
v42 and earlier peers fail the handshake before reading incompatible results.

`usage.balance` and `usage.pool` accept a raw `api_key` or an ordered `env_vars`
list. With no explicit key (and no `credential_id` for a balance read), the
sidecar resolves those names with the Agent's `get_env_value_prefer_dotenv`
inside `scoped_home`, including the profile's secret sources. Older Agents
without that resolver use `agent.secret_scope.get_secret`; if neither scoped
resolver exists, the sidecar returns no key. The sidecar never reads the process
environment directly as a fallback. Unresolved `op://` references
are never sent to a balance endpoint. Pool-account reads keep their own runtime
key and never fall back to another configured account. Resolved secrets stay in
the sidecar; pool matching returns `matches_api_key` and a `has_api_key` boolean.
Quota source membership uses that scoped presence even when the server has no
raw key, and suppresses the provider source only when a pool account matches it.

`usage.pool_providers` accepts `key_envs`, mapping providers to their ordered
environment names. It returns presence and a process-salted HMAC revision for
each resolved key. Resolved keys and the salt never leave the sidecar. The
server checks this metadata before reusing provider/model catalogs or session
repair data and includes revisions in its existing source fingerprint. Concurrent
metadata reads for the same profile and source identity share one request. A failed metadata read keeps
last-confirmed display identity but cannot authorize session-model repair. A
sidecar restart changes the opaque revisions and invalidates those caches.

## Gateway lifecycle consent

`gateway.control` and `gateway.restart` accept optional `interrupt: boolean`,
defaulting to false. For an installed Agent with `hermes_cli.gateway_lifecycle_guards`,
stop and restart pass `--yes` only with explicit consent, and restart always passes
`--detach`. Older Agents retain their original command line. An exit-1 live-work
refusal returns `busy_live_work` with the bounded Agent reason line.

Tools actions and explicit operational restarts consent to interruption. The
post-update restart queue passes its Restart now intent; automatic attempts wait
on live-work refusals, retain the notification and poll again. Existing gateway
counts remain advisory; the Agent guard also covers cron and delegated work.

### Startup correlation

The request envelope optionally carries `trace_id` (UUID). It is diagnostic
metadata, not an execution or admission key; older peers may ignore it.
`CallContext` captures receipt and worker start separately for `chat.start` and
passes its recorder explicitly into the chat handler. Callback threads retain
that call's recorder rather than consulting process-global session context.
Bounded redacted startup records go to stderr, never to a per-token RPC stream
or a client endpoint. See [the startup breakdown](../troubleshooting.md#chat-startup-phase-breakdown)
for process clock limits, retrieval, and unsupported provider boundaries.

## Native model picks

`gateway.session` preserves `session.mutate` receipts separately from prompt admissions.
The server maps model receipts and `session.updated` outcomes to `model_change` on the
owner-action response and `owner_attachment` view. An applied receipt has no `status`;
`deferred` retains the committed model until the next turn boundary. A guarded pick
carries the owner's message, target model/provider and `confirm` token. The existing
confirmation dialog re-sends that token as `payload.confirm` with current owner fences.

A native idle mutation has no execution stamp. Its session-scoped subscription and replay
still carry it; turn-generation filtering must not discard it. Observation of a deferred
pick stays attached past the idle notification until its outcome is projected. In-flight
model mutations fence idle settlement before dispatch; every result releases that fence
and rechecks settlement through the ordered owner-event queue. Outcomes
are observations in server memory, scoped by profile home, session, authority and replay
epoch. They never write a second session or change the owner's canonical transcript.

### Plugin settings and live MCP application

`plugins.settings_save` persists declared settings before reconciling live MCP
launch inputs on its RPC worker under the saved profile's scope. It uses the
Agent package reader, server-name normalizer, ownership map, and native serialized
reconnect helper. Native-config name collisions and servers owned by another
plugin are excluded. Unchanged inputs keep their connection; borrower detachment
and reconnection remain Agent-owned. Changed connections refresh the saved
profile's cached Agent tool schemas through the existing MCP refresh path.

The result's `runtime_application` is separate from persistence: `applied`,
`restart_required` when the installed Agent lacks the helper or reports a failed
connection, and `unknown` when reconnect completion cannot be confirmed. Runtime
failures retain confirmed saved settings and secrets, never trigger an automatic
reconnect retry, and expose no exception or launch environment. The HTTP save
result always includes this field; an older sidecar without it projects
`restart_required`. A lost save response remains HTTP 503
`plugin_settings_unconfirmed`, preserving secrets for readback rather than
rolling back an operation that may already have persisted.


### Stopping background work

RPC v52 adds `process.stop`. It receives the profile home, owning session id and process/delegation id.
It rechecks ownership before killing a process with `consume_output: false` or
requesting cooperative interruption of a delegation's active subagents. Split units
select only their task indexes within the call's shared subagent roster. Child
ownership matches the unit's captured execution parent, so compression rotations
do not lose control of work still owned by the original Web session. It returns
`stopped`, `not_running` or `not_found`; failed kills/interruptions remain errors.
A stop request never fabricates a terminal receipt. The Agent's existing completion
path settles the row. The HTTP server publishes `can_stop` only for confirmed running
owned work, and both Background work and Agents reuse the same Stop/Dismiss action.
Native owner controls are outside this direct-sidecar API.

### Context inspection

`chat.context_detail` reads only a matching resident Agent in the requested profile,
model, provider and workspace. It never creates an Agent or calls a model provider.
`gateway.session` with `action: context_detail` uses the authenticated owner's
`session.context_breakdown` and optional `session.stats`, fenced by the resumed
session identity, revision, authority/replay epochs and execution generation.
Both paths use the same bounded metadata projection. Category estimates remain
independent of occupancy, with explicit provenance and unknown counters. File
bodies, private paths, arbitrary labels and diagnostics never cross this boundary.

`GET /api/session/context-detail` requires the displayed `context_detail_key`,
applies session visibility, and rejects reads from a different rendered identity
or a resident session that changes before the read returns. Workspace changes
retire the cached resident Agent through the existing session-update boundary.
Session views carry an opaque
`context_detail_key` so clients discard details on context/owner replacement.
Web mounts the query only inside the existing open ring popover or mobile context
row, with no retained cache. Unsupported and pre-build reads are unavailable.

RPC version 55 adds `drafts.review`, the profile/session-scoped outbound draft
adapter. Its read/edit/approve variants share typed producer content and action
fields. It does not import producer code or call its unsafe HTTP approval route.
The reviewed source identity and explicit native plugin consent are revalidated;
SQLite transactions serialize version checks and writes with native tool writers.
No send or chat-start action is exposed by this method.

### Declared MCP costs

RPC v58 adds `mcp.cost_policies`. The server supplies its profile's saved native
server entries; the sidecar uses the installed Agent parser and the scoped cached
portable-package declarations. This read never calls a tool, reconnects a server,
or changes a runtime's frozen policy. It returns validated scalar/range/note values,
explicit native overrides, field sources and a package-declaration fingerprint.
Validation errors expose fixed wording rather than raw config values.

`GET /api/mcp/servers` includes an optional `cost_policy` on each applicable row.
`PUT /api/mcp/servers/{name}` accepts `cost_policy` and `config_revision` as a
policy-only patch. Null removes a native key, zero is explicit, and omitted keys
are preserved. The server checks the whole-config/profile/package revision under
the existing config update lock and validates the resulting policy before writing.
Package-only rows cannot be edited; native overrides inherit omitted package keys.
Every view reports `provenance: declared_estimate`, `reload_required: true` and
`runtime_state: unknown`. Saved declarations do not attest any owner's loaded
policy. The existing profile-scoped Reload MCP command remains an explicit action.

### Nous account result

RPC version 60 adds `providers.nous_account`, the optional `nous_account` OAuth
completion field, and the optional `nous_account_id` fence on `connectors.connect`.
The shared `NousAccountSchema` also appears on public provider rows and OAuth
responses. `approved` still means credentials were saved, independently of handoff
state. The sidecar reads native `handoff_status` / `wire_status`, masks email,
allowlists app IDs and copy inputs, and proves the selected record's destination
with the native binding helper even for terminal records. Raw native records,
credentials and exception details never enter this projection.

The bounded display cache holds at most 32 profile/account identities and retains
last-confirmed fields with `unavailable` on native read failure. It never writes a
transfer ledger or dispatches retries. The native worker owns progress. A flow
captures its account identity inside the persistence guard; late completion or
polling cannot adopt a replacement account. A response whose identity changes
during its read is discarded. Unknown identity clears the display.

The shared sign-in panel observes sequentially, at server `poll_after`, for at
most 120 reads per start. Provider rows use the same field with one Query owner
and the same bound. Reopening or refreshing reads native state again. A failed
transport read retains the last display with an unavailable notice. Provider RPC
failures use the catalog's existing source-fenced lookup cache and the optional
`nous_account_error` field without failing other provider rows. Changed credential
or configuration fingerprints discard the cached identity and reconnect actions. Reconnect is
explicit and checks profile/account identity, the current dropped-app result and
live catalog before composing the native connector operation, without provisioning
an identity. The native account starter always creates a live-credential client in
its later thread, so result reconnects instead reuse its `ConnectionOperation`,
`ConnectorClient`, `managed_kind` and `drive_operation` with an injected header
provider. Every request verifies both the current profile identity and the bearer
subject without refreshing. Rejoins, reads and retries keep that fence; an account
change settles the operation and removes its link from the current account's view. App presentation of these optional fields is tracked separately.

RPC v62 adds `skills.revisions`, the bounded read-only store adapter described in
[Saved skill revisions](../CONTRACTS.md#saved-skill-revisions). Inspection passes
`load_plugins=False` and `recover_processes=False` to the existing profile scope.
Both native context-local and legacy environment profile bindings retain those
flags. Other calls retain their existing process-recovery behavior. A v61 peer
is rejected at handshake before Agent loading.

RPC v65 adds `profiles.import` with `discover`, `preview`, `apply` and read-only
`result` actions. The shared result is `AgentImportResultSchema`. The adapter
loads attested structured importer/sync APIs, not plugin CLI output or Desktop
code. See Coding-agent profile import in `docs/CONTRACTS.md`.
