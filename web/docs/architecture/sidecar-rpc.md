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
contracts package, plus one JSON fixture used by the sidecar pytest suite and
the Vitest fake sidecar.

| Namespace | Methods | Streams | Python origin |
|---|---|---|---|
| `runtime` | `handshake`, `status`, `shutdown` | | `api/agent_runtime.py`, `api/startup.py` |
| `chat` | `start` (streamed), `interrupt`, `steer`, `evict_agent`, `snapshot_transcript` | `token`, `reasoning`, `tool`, `tool_complete`, `interim_assistant`, `approval`, `clarify`, `status`, `compressing`, `compressed`, `context_status`, `goal`, `goal_continue`, `metering`, `done`, `error` | `api/streaming.py`, `api/session_lifecycle.py`, `api/runtime_adapter.py` |
| `approval` | `pending`, `respond`, `set_yolo` | `approval` (out-of-turn mirror) | `api/route_approvals.py` |
| `clarify` | `pending`, `respond` | | `api/clarify.py` |
| `goals` | `get`, `save`, `command` | | `api/goals.py` |
| `cron` | `list`, `get`, `create`, `update`, `delete`, `pause`, `resume`, `run` (streamed), `history`, `output`, `delivery_options`, `status` | `run_output` | `api/routes.py` cron section |
| `profiles` | `list`, `active`, `create`, `seed`, `delete`, `runtime_env` | | `api/profiles.py` |
| `commands` | `registry`, `exec` (streamed), `reload_skills`, `reload_mcp`, `moa_presets`, `codex_runtime_switch` | `output` | `api/commands.py` |
| `plugins` | `list`, `handlers`, `providers` | | `api/plugins.py`, `api/plugin_providers.py` |
| `skills` | `list`, `index`, `parse`, `usage` | | `api/routes.py` skills section, `api/skill_usage.py` |
| `providers` | `registry`, `resolve_runtime`, `auth_status`, `model_ids`, `credential_pool`, `openrouter_models`, `reasoning_probe`, `fast_mode` | | `api/config.py`, `api/providers.py` |
| `models` | `catalog`, `context_length`, `estimate_tokens`, `metadata`, `models_dev` | | `api/config.py`, `api/message_window.py` |
| `aux` | `call_llm` (streamed), `title`, `commit_message`, `compression_summary`, `handoff_summary`, `compression_feedback` | `token` | `api/streaming.py`, `api/reasoning_titles.py`, `api/compression_anchor.py` |
| `text` | `redact`, `image_routing`, `portal_tags` | | `api/helpers.py` |
| `stt` | `capability`, `transcribe` | | `api/routes.py` transcribe |
| `mcp` | `servers`, `tools`, `status`, `discover`, `shutdown` | | `api/mcp_health.py`, `api/routes.py` |
| `process` | `list`, `drain` (streamed), `ack`, `format_notification` | `completion` | `api/background.py`, `api/process_event_utils.py` |
| `state_db` | `sync_message_count`, `set_title`, `set_tokens`, `set_goal_meta`, `delete_cli_session` | | `api/state_sync.py`, `api/webui_session_db.py` |
| `kanban` | `boards`, `board`, `switch_release`, `tasks`, `task`, `create_task`, `patch_task`, `dispatch`, `bulk`, `comments`, `log`, `block`, `unblock`, `links`, `delete_link`, `stats`, `assignees`, `config`, `events` (streamed) | `events` | `api/kanban_bridge.py` |
| `usage` | `account` | | `api/usage.py` |
| `gateway` | `status`, `restart` (streamed), `capabilities` | `progress` | `api/gateway_restart.py`, `api/gateway_watcher.py` |

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
