# Sidecar RPC (TAL-245)

The TypeScript server never imports Hermes Agent code. Everything that needs
Agent Python modules runs in one Web-owned sidecar process,
`python -m talaria_sidecar`, spawned on the Agent's own venv interpreter with
`PYTHONPATH=<agent dir>`. The sidecar is stdlib-only Python; it has no pip
dependencies of its own and installs nothing.

## Ownership

| Concern | Owner |
|---|---|
| Agent pin (`sidecar/agent_dependency.json`), drift guard, loaded-revision check | sidecar |
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
application errors in `-32000..-32099` mapped one-to-one from the Python
backend's error conditions (`agent_runtime_stale`, `agent_incompatible`,
`profile_fail_closed`, `credential_missing`, `interrupted`, `timeout`). The
`data.condition` string is the value the server forwards to HTTP clients.

## Lifecycle

1. Server discovers the Agent directory and venv with the same rules as today
   (`HERMES_WEBUI_AGENT_DIR`, `$HERMES_HOME/hermes-agent`, sibling checkout,
   `~/hermes-agent`, `/opt/hermes`, `/usr/local/lib/hermes-agent`; venv at
   `<agent>/venv` or `<agent>/.venv`).
2. Server spawns the sidecar and sends `runtime.handshake` with
   `{rpc_version, hermes_home, state_dir}`.
3. Sidecar imports `run_agent`, reads its own `agent_dependency.json`, compares
   the loaded checkout revision, and replies
   `{rpc_version, agent_revision, pinned_revision, compatible, stale, python, agent_dir, capabilities}`.
   A `rpc_version` mismatch is a fatal handshake error; the sidecar exits 3.
4. Server sets `AGENT_DEPS_READY` only after a compatible handshake. While the
   sidecar is absent, restarting, stale, or incompatible, chat and every
   sidecar-backed route answer 503 with `condition` set to
   `sidecar_unavailable`, `agent_runtime_stale`, or `agent_incompatible`.
5. On sidecar exit the server restarts it with exponential backoff (1 s, 2 s,
   4 s, capped at 30 s). Every in-flight request fails with
   `sidecar_unavailable`. Session-scoped agent caches are lost, as they are on
   a Python restart today.
6. The drift guard runs inside the sidecar on every chat turn: if the Agent
   checkout revision or update markers changed since import, the call fails
   with `agent_runtime_stale` and the sidecar refuses further chat calls until
   restarted, mirroring `api/agent_runtime.py`.

One sidecar per server. Concurrency inside the sidecar is thread-per-call for
long-running methods (chat turns, cron runs, auxiliary LLM calls) and a
single dispatcher thread for everything else, preserving the per-session
serialization the Python backend enforces with `SESSION_AGENT_LOCKS`.

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

| Namespace | Methods | Streams | Python origin |
|---|---|---|---|
| `rpc` | `cancel`, `methods` | | transport |
| `runtime` | `handshake`, `status`, `ensure_current`, `shutdown` | | `api/agent_runtime.py`, `api/startup.py` |
| `goals` | `get`, `command`, `snapshot`, `restore`, `evaluate` | | `api/goals.py` |
| `commands` | `registry`, `exec`, `moa_preset` | | `api/commands.py` |
| `plugins` | `providers` | | `api/plugin_providers.py` |
| `kanban` | `board`, `boards`, `create_board`, `update_board`, `delete_board`, `switch_board`, `task`, `create_task`, `patch_task`, `task_action`, `comment`, `link`, `unlink`, `events`, `config`, `stats`, `assignees`, `task_log`, `bulk`, `dispatch` | | `api/kanban_bridge.py` |
| `state_db` | `sync_start`, `sync_usage`, `sync_title`, `delete_cli_session` | | `api/state_sync.py`, `api/models.py` |
| `profiles` | `list`, `create`, `delete`, `runtime_env`, `skills_stats` | | `api/profiles.py` |
| `skills` | `list`, `view`, `find` | | `api/routes.py` skills section |
| `mcp` | `status`, `registry_tools`, `reload` | | `api/routes.py` MCP section |
| `stt` | `capability`, `transcribe` | | `api/upload.py` |
| `cron` | `list`, `get`, `create`, `update`, `delete`, `pause`, `resume`, `run`, `status`, `history`, `run_detail`, `output`, `delivery_options` | `run`: `started` | `api/routes.py` cron section |
| `providers` | `registry`, `auth_status`, `model_ids`, `resolve_runtime`, `credential_pool` | | `api/config.py`, `api/providers.py` |
| `models` | `context_length`, `estimate_tokens`, `capabilities` | | `api/config.py`, `api/message_window.py` |
| `aux` | `complete`, `resolve` | `complete`: `token` | `api/streaming.py`, `api/routes.py` |
| `text` | `redact`, `image_mode`, `portal_tags` | | `api/helpers.py`, `api/streaming.py` |
| `process` | `drain`, `requeue`, `mark_consumed`, `format_notification`, `list` | | `api/background_process.py`, `api/streaming.py` |
| `usage` | `account` | | `api/providers.py` |
| `gateway` | `restart` | `restart`: `progress` | `api/gateway_restart.py` |
| `chat` | `start`, `interrupt`, `steer`, `evict_agent`, `snapshot_transcript` (checkpoint 6) | `token`, `reasoning`, `tool`, `tool_complete`, `interim_assistant`, `approval`, `clarify`, `status`, `compressing`, `compressed`, `context_status`, `metering`, `done`, `error` | `api/streaming.py` |
| `approval`, `clarify` | `pending`, `respond`, `set_yolo` (checkpoint 6) | | `api/route_approvals.py`, `api/clarify.py` |

What stays in the server, by design: WebUI files and `config.yaml` / `.env`
writes, MCP config edits and HTTP/stdio health probes, skill file writes,
kanban query parsing and the SSE poll loop, cron cross-profile merging and
running-state display, provider catalog composition and caches, dashboard
plugin manifests, `state.db` read-only projections.

Chat turns keep the in-process callback model inside the sidecar exactly as
the Python backend does today: `AIAgent` is constructed with signature-gated
kwargs, callbacks translate to stream frames, `interrupt()` is `chat.interrupt`,
approvals and clarify prompts raised by tools block inside the sidecar until
the server answers with `approval.respond` / `clarify.respond`, and the
per-session agent cache lives in the sidecar.

## Versioning

`rpc_version` is an integer in the contracts package
(`SIDECAR_RPC_VERSION`). Any change to a method's params, result, or stream
frames bumps it. The sidecar refuses to start on a mismatch. Both the fake
sidecar and the real one are tested against the same fixtures, so a drift
between them is a failing test, not a runtime surprise.
