# Sidecar RPC (TAL-245)

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

## Ownership

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

One sidecar per server. Concurrency inside the sidecar is thread-per-call for
long-running methods (chat turns, cron runs, auxiliary LLM calls) and a
single dispatcher thread for everything else. A session has at most one chat
run at a time.

Provider-plugin listings retain the scoped home's manifest enable/disable gate. With
`plugins.isolation: host`, the sidecar maps enabled plugin directories through the
Agent's cached hosted-profile metadata and selects providers from its per-home
user registry. Provider ids may differ from manifest names. In-process and older
Agents retain module ownership checks, so another profile's plugins stay hidden.
Hosted ids claimed by multiple directories remain `not_loaded`, including collisions
with disabled or manifest-less plugins. Their model catalogs remain empty.

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

| Namespace | Methods | Streams |
|---|---|---|
| `rpc` | `cancel`, `methods` | |
| `runtime` | `handshake`, `status`, `ensure_current`, `shutdown` | |
| `goals` | `get`, `command`, `snapshot`, `restore`, `evaluate` | |
| `commands` | `registry`, `exec`, `bundles`, `bundle_resolve`, `moa_preset` | |
| `plugins` | `providers`, `list` | |
| `kanban` | `board`, `boards`, `create_board`, `update_board`, `delete_board`, `switch_board`, `task`, `create_task`, `patch_task`, `task_action`, `comment`, `link`, `unlink`, `events`, `config`, `stats`, `assignees`, `task_log`, `bulk`, `dispatch` | |
| `state_db` | `sync_start`, `sync_usage`, `sync_title`, `delete_cli_session`, `append_message` | |
| `profiles` | `list`, `create`, `delete`, `runtime_env`, `skills_stats` | |
| `skills` | `list`, `view`, `find` | |
| `mcp` | `status`, `registry_tools`, `reload` | |
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
| `chat` | `start`, `interrupt`, `steer`, `evict_agent` | `start`: `token`, `reasoning`, `interim_assistant`, `tool`, `tool_complete`, `approval`, `clarify`, `clarify_resolved`, `compressing`, `warning`, `status`, `context_status`; the settled transcript, usage, and terminal status come back as the result |
| `approval`, `clarify` | `approval.pending`, `approval.respond`, `approval.set_yolo`, `clarify.respond` | |
| `worktree` | `create` | |
| `checkpoints` | `list`, `diff`, `restore` | |
| `memory` | `check`, `write` | |
| `config` | `get`, `set`, `env_write` | |

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

Agent v0.21.6 clarify callbacks receive a normalized question list. The sidecar
emits it in the existing batch frame, and the server returns a validated keyed
answer envelope. The callback returns `answers` and `outcome` to the Agent:
`submitted`, `cancelled`, or `timed_out`. Cancellation and timeout contain no
fabricated answer. The two older supported Agent releases retain their legacy
callback and result shapes until the support window drops them.

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

Manual `/compress` is `chat.compress`: a throwaway `AIAgent` runs the Agent's
shared `compress_now` core over the history the server sends and returns the
compressed messages and summary without persisting anything. The server
re-checks the session under its lock (a stream that started or a transcript
that changed during the call is a 409) before it installs the result as the
model context, so the browser job and the iOS route share one worker. The
Agent's context-engine notification is two-phase: a compressed result carries a
`commit_token`, and the server answers `chat.compress_finalize` with whether it
installed the result (an unanswered token is discarded after ten minutes).

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

## Process heartbeat progress

Process heartbeat events are progress. The server keeps their receipt running with the latest
output and wakes the owning session with the Agent's `process.format_notification` text, deferred
while a turn is active. Each heartbeat has its own delivery identity and consumes no process exit.
Heartbeat-only prompts persist with `display_kind: hidden`; clients receive `_display: hidden`.
Meaningful agent replies and batches containing completions remain visible. Heartbeats emit neither
`bg_task_complete` nor `process_complete`. Agents without heartbeat support return empty formatter text.

## Versioning

`rpc_version` is an integer in the contracts package
(`SIDECAR_RPC_VERSION`). Any change to a method's params, result, or stream
frames bumps it. The sidecar refuses to start on a mismatch. Both the fake
sidecar and the real one are tested against the same fixtures, so a drift
between them is a failing test, not a runtime surprise.

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
