# Backend parity matrix (TAL-245)

This is the checked-in inventory for the TypeScript rewrite of the Talaria Web
backend. Every capability of the Python backend (`server.py`, `api/*.py`,
`bootstrap.py`, `ctl.sh`, `mcp_server.py`) at the ticket's creation commit
(`db3f02679`) is listed with its new owner and the verification that proves it.
It is a contract document: a row may not be removed silently. A capability that
is intentionally dropped says so in `Status` with the decision reference
(TAL-245 "Decisions" table or "Dropped (no consumer)" list).

Owner vocabulary:

| Owner | Meaning |
|---|---|
| `server` | `@maudecode/talaria-web` (Node 24, `packages/server`) |
| `contracts` | `@maudecode/talaria-web-contracts` (`packages/contracts`) |
| `sidecar` | `talaria_sidecar` Python package on the Agent venv (`sidecar/`) |
| `frontend` | `packages/frontend` (moved from `frontend/`) |
| `dropped` | intentionally removed; the `Notes` column names the decision |

Verification vocabulary: `vitest` (contracts/server/frontend unit or
integration test), `fixture` (fixture-compat test against files or values
produced by the Python backend at `db3f02679`), `pytest` (sidecar suite against
the pinned Agent), `pw` (Playwright e2e against the TS server), `ci` (a CI job
or diff gate), `docker` (`scripts/check-docker.py`), `manual` (documented in the
PR body, no automated test yet).

Status vocabulary: `pending` (not yet implemented in this branch), `pass`,
`partial` (notes name the reduction), `dropped`.

The final checkpoint commit turns every `pending` row into `pass`, `partial`, or
`dropped`; the PR body reports the counts.

## 1. HTTP dispatch and cross-cutting behaviour

| ID | Capability | Python source | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| H1 | Request pipeline order: profile cookie, `Origin: null` rejection on `/api/*`, auth (public / operator-only / profile mismatch 403), startup-readiness gate (503 `startup_recovery`, `Retry-After: 5`, exemptions), handler, 404/500 envelopes, client-disconnect swallow | `server.py`, `api/auth.py` | server | vitest | partial | checkpoint 4: pipeline, `Origin: null`, auth gate, startup gate, JSON 404/500 in `packages/server/src/app.ts` (`app.test.ts`); client-disconnect swallow lands with SSE |
| H2 | CSRF: same-origin check (Origin/Referer/`Sec-Fetch-Site`, trusted forwarded host, allowed origins) plus HMAC token header for browser requests; non-browser clients bypass; exempt paths | `api/auth.py` | server | vitest, fixture | pass | Token HMAC must verify tokens minted by Python; checkpoint 4: `http/origin.ts`, `auth/gate.ts`; Python-minted token vectors in `auth/store.test.ts` |
| H3 | Cookies: `hermes_session` `<token>.<hmac>` with legacy truncated signature, `hermes_profile` signed when auth on, TTL clamp, sliding renewal, `Secure` rules, trusted-header auth | `api/auth.py` | server | vitest, fixture | pass | checkpoint 4: `auth/store.ts` reads Python `.sessions.json`, `.signing_key`, `.pbkdf2_key`; trusted-header flow in `app.test.ts` |
| H4 | Security headers, CSP template and report-only twin, sandbox CSPs for extension panels, plugin assets, raw previews | `api/helpers.py` | server | vitest | partial | checkpoint 4: security headers and CSP twin (`http/csp.ts`); extension/plugin sandbox CSPs land with checkpoint 7 |
| H5 | Trusted proxy resolution (CIDRs, XFF walk, `X-Real-IP`), local-origin gate for onboarding/terminal, request base URL for OIDC | `api/helpers.py`, `api/auth.py` | server | vitest | partial | checkpoint 4: trusted proxy CIDRs, XFF walk, `X-Real-IP` (`http/origin.ts`); local-origin gate and OIDC base URL later |
| H6 | TLS (cert/key, min 1.2, HTTP fallback), bind host/port/IPv6, refuse-to-start when `/health` already answers | `server.py` | server | vitest | pass | checkpoint 4: `server.ts` (TLS 1.2+, HTTP fallback, `isAlreadyServing` probe) |
| H7 | Worker budget: observable limits (8 streams per client identity, 503 `request_worker_capacity` / `client_stream_limit`), handler idle timeout, keepalive | `api/http_server.py` | server | vitest | pending | Node reproduces the observable limits, not the thread pool |
| H8 | Rate limits: login 5/60 s persisted, CSP report, client events, native OIDC start, passkey | `api/auth.py`, `api/routes.py` | server | vitest, fixture | partial | `.login_attempts.json` format preserved; checkpoint 4: login limiter with the persisted file; CSP report, client events, OIDC, passkey limiters later |
| H9 | JSON envelope: gzip above 1 KiB, `no-store`, weak ETag/304; error envelope `{error, code?}` and variants (`condition`, `replaced_by`, health 503 payload) | `api/helpers.py` | server, contracts | vitest | partial | checkpoint 4: gzip/`no-store`/weak ETag in `http/context.ts`; oRPC error bodies mapped to `{error}` (`api/router.ts`); health 503 payload via `RawResponse` |
| H10 | Body limits: 20 MiB read cap, multipart parser (`HERMES_WEBUI_MAX_UPLOAD_MB`), folder zip limits | `api/upload.py`, `api/helpers.py` | server | vitest | pending | |
| H11 | Structured access log, slow-request watchdog, `HERMES_WEBUI_TEST_NETWORK_BLOCK` | `api/request_diagnostics.py`, `api/logging_hygiene.py` | server | vitest | partial | checkpoint 4: structured access log; watchdog and network block later |
| H12 | Deferred startup: session recovery (`STARTUP_READY`), agent deps (`AGENT_DEPS_READY` via sidecar handshake), workers, plugins (`PLUGINS_READY`), relay publisher; signal handling; shutdown drain | `api/startup.py`, `server.py` | server | vitest | partial | checkpoint 4: `StartupGate` with bounded waiters and `Retry-After: 5`; recovery/deps/plugins arming lands with their domains |

## 2. Routes

Route classes: `browser` (frontend), `ios`, `mcp`, `ext` (extension SDK /
sidecar proxy), `relay`, `e2e`. Auth class: `public`, `auth`, `operator`.

### 2a. Auth and identity

| ID | Route | Consumers | Auth | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| R-A1 | `GET /api/bootstrap` | browser | public | server | vitest, pw | pass | checkpoint 4 (`api/router.ts`); `pw` runs on the TS server from checkpoint 8 |
| R-A2 | `GET /api/auth/status` | browser, ios | public | server | vitest | pass | checkpoint 4 |
| R-A3 | `POST /api/auth/login`, `POST /api/auth/logout` | browser, ios, mcp | public / auth | server | vitest, fixture | pass | PBKDF2 hashes from Python verify; checkpoint 4; legacy `.signing_key` hashes migrate on login |
| R-A4 | `GET /api/auth/oidc/start`, `GET /api/auth/oidc/callback` | browser, ios | public | server | vitest | pending | |
| R-A5 | `POST /api/auth/oidc/native/start|exchange|cancel` | ios | public | server | vitest | pending | HttpOnly/Secure cookie in exchange response |
| R-A6 | `POST /api/auth/passkey/options|login` | browser | public | server | vitest, fixture | pending | |
| R-A7 | `POST /api/auth/passkey/register/options|register|delete`, `POST /api/auth/passkeys` | browser | operator | server | vitest, fixture | pending | |

### 2b. Sessions

| ID | Route | Consumers | Auth | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| R-S1 | `GET /api/sessions`, `GET /api/sessions/search` | browser, ios | auth | server | vitest, fixture, pw | partial | ETag/304, cache, `expand_renderable`, `show_*_sessions`, `archived_limit`; checkpoint 5a: list/search with ETag/304, `show_*_sessions`, `archived_limit/offset` in `sessions/list.ts`; state.db CLI rows and `expand_renderable` pending |
| R-S2 | `GET /api/session`, `GET /api/session/status`, `GET /api/session/usage`, `GET /api/session/export` | browser, ios | auth | server | vitest, fixture | pass | checkpoint 5a: `GET /api/session|status|usage` with the bounded message window (`sessions/window.ts`); `export` lands with 5b; checkpoint 5b: `GET /api/session/export` (JSON and self-contained HTML via `text/markdown.ts`) as a raw pipeline route |
| R-S3 | `POST /api/session/new|rename|delete|pin|archive|move|duplicate|branch|truncate|undo|retry|clear|update` | browser, ios, mcp | auth | server | vitest | partial | `delete` state.db cleanup via sidecar; checkpoint 5a: all mutations in `sessions/service.ts`; state.db cleanup and journal-backed recovery pending |
| R-S4 | `POST /api/session/title/regenerate`, `POST /api/session/import`, `POST /api/session/import_cli` | browser, ios | auth | server (+sidecar for titles) | vitest | partial | checkpoint 5a: `import`; `title/regenerate` and `import_cli` need the sidecar/state.db |
| R-S5 | `GET|POST /api/session/yolo`, `POST /api/session/toolsets` | browser, ios | auth | server | vitest | partial | checkpoint 5a: yolo is process-local, toolsets validated and persisted |
| R-S6 | `POST /api/session/compress`, `POST /api/session/compress/start`, `GET /api/session/compress/status`, `POST /api/session/handoff-summary` | browser, ios | auth | server + sidecar | vitest, pytest | pending | |
| R-S7 | `POST /api/session/draft` | browser | auth | server | vitest, fixture | pass | monotonic `_draft_version`; checkpoint 5a: `sessions/drafts.ts`, 409 with the current draft on stale versions |
| R-S8 | `GET /api/session/worktree/status`, `POST /api/session/worktree/remove` | browser | auth | server | vitest | pass | checkpoint 5b: `workspace/worktrees.ts`; creation goes through the new sidecar `worktree.create` (Agent `_setup_worktree`) |
| R-S9 | `POST /api/sessions/cleanup_zero_message` | browser | auth | server | vitest | pass | checkpoint 5a |
| R-S10 | `GET /api/sessions/events` | browser | auth | server | vitest | pending | SSE, see 3 |
| R-S11 | `GET /api/session/anchor-scene`, `POST /api/session/anchor-scene`, `POST /api/session/compression-recovery/start`, `POST /api/session/conversation-rounds`, `GET /api/session/recovery/audit`, `POST /api/session/recovery/repair-safe`, `GET /api/session/lineage/report`, `POST /api/sessions/cleanup`, `GET /api/sessions/gateway/stream`, `GET /api/sessions/<sid>/events`, `GET /api/session/stream` | none | | dropped | dropped | TAL-245 dropped list. `/api/session/stream` reference in `contracts/sse.ts` is a comment only; checkpoint 5a keeps `anchor-scene` GET/POST (browser consumer) in `sessions/anchor.ts` |
| R-S12 | `GET /api/projects`, `POST /api/projects/create|rename|delete` | browser, ios | auth | server | vitest, fixture | pass | checkpoint 5a: `projects.ts` with profile backfill; cascading unlink on delete |

### 2c. Chat, approvals, clarify, goals, background

| ID | Route | Consumers | Auth | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| R-C1 | `POST /api/chat/start`, `POST /api/chat/steer`, `GET /api/chat/cancel` | browser, ios | auth | server + sidecar | vitest, pytest, pw | partial | checkpoint 6: `sessions/turn.ts` admits turns, persists pending state (deferred/eager), calls sidecar `chat.start`, settles the transcript, cancels via `chat.interrupt`, steers via `chat.steer`; regeneration, MoA overrides, process-wakeup turns, and gateway-backed runs pending |
| R-C2 | `GET /api/chat/stream`, `GET /api/chat/stream/status` | browser, ios | auth | server | vitest, pw | pass | SSE, see 3; checkpoint 6: `api/sse-routes.ts` chat relay with journal replay, offline-gap recovery, cursor dedupe, and `/api/chat/stream/status` |
| R-C3 | `POST /api/chat` (sync legacy) | none | | dropped | | dropped | TAL-245 dropped list |
| R-C4 | `GET /api/approval/pending`, `POST /api/approval/respond`, `GET /api/approval/stream` | browser, ios | auth | server + sidecar | vitest, pytest | partial | checkpoint 6: server-side queues (`sessions/pending.ts`) mirror sidecar `approval` frames; respond relays `approval.respond`/`approval.set_yolo`; gateway run mirrors are not ported |
| R-C5 | `GET /api/clarify/pending`, `POST /api/clarify/respond`, `GET /api/clarify/stream` | browser, ios | auth | server + sidecar | vitest, pytest | pass | checkpoint 6: clarify frames, timeout metadata, dedupe, `clarify.respond` |
| R-C6 | `GET /api/approval/inject_test`, `GET /api/clarify/inject_test` | app contract runner only | | dropped | | dropped | Replaced by a scripted sidecar approval fixture in `app/scripts/validate-upstream-contract` |
| R-C7 | `POST /api/goal` | browser, ios | auth | server + sidecar | vitest, pytest | partial | checkpoint 6: `/api/goal` through sidecar `goals.*` with kickoff turns; goal evaluation after a turn (`goal`/`goal_continue` frames) pending |
| R-C8 | `POST /api/background`, `GET /api/background/status`, `POST /api/bg-task-complete-ack` | browser, ios | auth | server + sidecar | vitest | pass | checkpoint 6: hidden background sessions with parent-scoped results; `bg-task-complete-ack` no-op |
| R-C9 | `POST /api/process-complete-ack` | none | | dropped | | dropped | 410 stub today |
| R-C10 | `POST /api/btw` | ios | auth | server + sidecar | vitest | pass | checkpoint 6: ephemeral `/btw` session removed after `done` |

### 2d. Files, workspace, media, upload, git, rollback

| ID | Route | Consumers | Auth | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| R-F1 | `GET /api/list`, `GET /api/file`, `GET /api/file/raw`, `GET /api/folder/download`, `GET /api/media` | browser, ios | auth | server | vitest | pass | checkpoint 5a: `list` and `file` via anchored fd walks in `workspace/fs.ts`; raw/media/download are 5b pipeline routes; checkpoint 5b: `/api/file/raw`, `/api/media` (deny model, MEDIA: tokens, `snap=` digests, ETag/Range), `/api/folder/download` (`workspace/zip.ts`) in `api/raw-routes.ts`; contracts `RAW_ROUTES` feeds the OpenAPI document |
| R-F2 | `POST /api/file/create|create-dir|delete|move|rename|save|reveal|open-vscode` | browser | auth | server | vitest | pass | checkpoint 5a: `move` accepts `dest_dir` and the frontend `destination` |
| R-F3 | `POST /api/file/office-save`, `POST /api/file/path` | none | | dropped | | dropped | Office documents dropped (Decisions) |
| R-F4 | `POST /api/upload`, `POST /api/upload/rollback` | browser, ios | auth | server | vitest | pass | checkpoint 5b: multipart parser and per-session inbox with inode-bound rollback receipts (`workspace/upload.ts`) |
| R-F5 | `POST /api/upload/extract`, `POST /api/workspace/upload` | none | | dropped | | dropped | |
| R-F6 | `GET /api/escape/list|file/read|file/raw`, `POST /api/escape/authorize` | none | | dropped | | dropped | |
| R-F7 | `GET /api/workspaces`, `GET /api/workspaces/suggest`, `POST /api/workspaces/add|remove|rename|reorder` | browser, ios | auth | server | vitest, fixture | pass | checkpoint 5a: `workspace/workspaces.ts`; per-profile config.yaml reads land with checkpoint 7 |
| R-F8 | `GET /api/git-info`, `GET /api/git/status|diff|branches`, `POST /api/git/checkout|commit|commit-message|commit-message-selected|commit-selected|discard|fetch|pull|push|stage|stash-checkout|unstage` | browser, ios | auth | server (+sidecar for commit-message aux LLM) | vitest | pass | Hardened git runner; checkpoint 5b: `workspace/git.ts` (hardened argv, env scrub, filter/merge-driver/remote-helper neutralisation, temp index for selected commits, 2 s status cache); commit messages use sidecar `aux.complete` |
| R-F9 | `GET /api/rollback/list|diff`, `POST /api/rollback/restore` | browser | auth | server | vitest | pass | Contract fix: `checkpoint` parameter; checkpoint 5b: `workspace/rollback.ts` reads blobs from the shadow repo index and accepts `id` as the frontend alias for `checkpoint` |

### 2e. Crons, kanban, extensions, terminal

| ID | Route | Consumers | Auth | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| R-K1 | `GET /api/crons`, `GET /api/crons/history|output|run|status|delivery-options`, `POST /api/crons/create|update|delete|pause|resume|run` | browser, ios | auth | server + sidecar | vitest, pytest | ported (7c) | Cross-profile rows merged in `tools/crons.ts`; manual runs stream through `cron.run` and answer on `started`; selected-profile provider/model snapshots are computed by the sidecar |
| R-K2 | `GET /api/crons/recent` | none | | dropped | | dropped | |
| R-K3 | `GET|POST|PATCH|DELETE /api/kanban/*` (boards, board, release switch, tasks, task actions, bulk, comments, log, block/unblock, links, stats, assignees, config, dispatch, events) | browser, ios | auth | server + sidecar | vitest, pytest | ported (7c) | Contract defines the real action set (`patch`, `block`, `unblock`, `comments`, `log`, `bulk`, `dispatch`); `move|archive|unarchive|delete` are frontend-only and go in checkpoint 8 |
| R-K4 | `GET /api/kanban/events/stream` | ios | auth | server | vitest | ported (7c) | Polls `kanban.events` every 1 s |
| R-K5 | `GET /api/extensions/status|manifests|registry`, `POST /api/extensions/install|uninstall|toggle|sidecar-proxy-consent` | browser, ext | auth / operator | server | vitest | partial (7c) | token-v1 sidecar auth (`extension_sidecar_auth`) not ported (consent/proxy answer 409/403); manifests exclude dropped dashboard plugins and theme/tts projections |
| R-K6 | `/extensions/*`, `/api/extensions/<id>/sidecar/*` proxy | ext | auth | server | vitest | ported (7c) | Legacy proxy auth only |
| R-K7 | `POST /api/terminal/start|input|resize|close`, `GET /api/terminal/output` | browser | auth (local origin) | server | vitest | ported (7c) | `node-pty` (optional native module; 500 `not supported` when it cannot load) |

### 2f. Settings, profiles, providers, models, onboarding

| ID | Route | Consumers | Auth | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| R-P1 | `GET|POST /api/settings` | browser, ios | auth | server | vitest, fixture | ported (7a) | Auth-state fields, password flows, `max_tokens` via config.yaml, version badges; `update_channel_version` mirrors `webui_version` (no channel tags in npm builds) |
| R-P2 | `GET /api/profiles`, `GET /api/profile/active`, `POST /api/profile/switch|create|delete` | browser, ios | auth / operator | server + sidecar | vitest, pytest | ported (7a) | Accepts `name` or `profile`; per-client switch sets the profile cookie; isolated mode still pinned off |
| R-P3 | `GET /api/models`, `GET /api/models/live`, `POST /api/models/refresh`, `POST /api/model/set`, `GET /api/model/auxiliary`, `POST /api/default-model` | browser, ios | auth | server + sidecar | vitest, pytest | ported (7a) | Live ids via `providers.model_ids` with a 24h cache; `refresh` without a provider evicts everything and answers the catalog; no fast-tier metadata beyond OpenAI GPT-5/o-series |
| R-P4 | `GET|POST /api/providers`, `POST /api/providers/delete|self-hosted`, `GET /api/provider/quota|quotas|cost-history` | browser, ios | auth | server + sidecar | vitest, pytest | partial (7a) | Plugin providers, credential-pool multi-account quota sources, DeepSeek/OpenCode balances, and the OpenAI-shadowed-Codex card rule are not ported |
| R-P5 | `GET /api/personalities`, `POST /api/personality/set`, `GET|POST /api/reasoning` | browser, ios | auth | server | vitest | ported (7a) | Supported efforts come from the Agent (`models.reasoning_efforts`); ZAI thinking-toggle special cases are not ported |
| R-P6 | `GET /api/onboarding/status`, `POST /api/onboarding/setup|probe|complete`, `POST /api/onboarding/oauth/start|cancel`, `GET /api/onboarding/oauth/poll` | browser | auth (local origin) | server + sidecar | vitest | partial (7a) | OAuth start/cancel/poll answer 501 (terminal `hermes auth` remains the path) |

### 2g. Skills, memory, prompts, commands, notes, share, misc

| ID | Route | Consumers | Auth | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| R-M1 | `GET /api/skills`, `GET /api/skills/content|usage`, `POST /api/skills/save|delete|toggle` | browser, ios | auth | server + sidecar | vitest | ported (7b) | List/view/find through `skills.*`; writes and the config.yaml toggle in `tools/skills.ts` |
| R-M2 | `GET /api/memory`, `POST /api/memory/write` | browser, ios | auth | server | vitest | ported (7b) | Accepts `section` or the frontend `target`; project context walk bounded at the git root |
| R-M3 | `GET|POST /api/prompts` | browser | auth | server | vitest | ported (7b) | `DELETE /api/prompts` kept (frontend delete path) |
| R-M4 | `GET /api/commands`, `POST /api/commands/exec` | browser, ios | auth | server + sidecar | vitest, pytest | ported (7b) | `bundles`, `bundles/resolve`, `moa/resolve` dropped |
| R-M5 | `GET /api/notes/sources|search` | browser | auth | server | vitest | partial (7b) | Disabled-by-default payload ported; when enabled, sources come from `mcp_servers` names only and Joplin search answers 502 |
| R-M6 | `GET /api/wiki/*` | none | | dropped | | dropped | One comment-only reference in the frontend |
| R-M7 | `POST /api/share/create|revoke`, `GET /api/share/<token>`, `/share` SPA | browser, public | auth / public | server | vitest, fixture | pass | checkpoint 5a: `sessions/shares.ts`, `X-Robots-Tag` on reads |
| R-M8 | `GET /api/insights`, `GET /api/logs`, `GET /api/system/health`, `GET /api/health/agent`, `POST /api/health/restart`, `GET /api/dashboard/status`, `POST /api/shutdown` | browser, ios | auth / operator | server (+sidecar for agent restart) | vitest | partial (7b) | Insights skip the state.db CLI merge; agent health reports `alive: null` (no gateway pid probe); system health uses loadavg/statfs |
| R-M9 | `GET|POST /api/dashboard/config`, `GET /api/project-os/dashboard`, `POST /api/admin/reload`, `GET /api/gateway/status`, `POST /api/gateway/start|stop|restart`, `/search`, `/v1` | none | | dropped | | dropped | |
| R-M10 | `GET /api/mcp/servers|tools`, `POST /api/mcp/servers/<name>` actions | browser | auth | server + sidecar | vitest | partial (7b) | PATCH/PUT/DELETE kept alongside the POST action body; no background health prober (`health: unknown`) |
| R-M11 | `GET /api/plugins` | browser | auth | server + sidecar | vitest | ported (7b) | Agent plugin visibility via `plugins.list`; WebUI dashboard plugins (`api/plugins.py`) dropped with the dashboard |
| R-M12 | `GET|POST /api/updates/check`, `POST /api/updates/apply|force|clear_lock|summary` | browser, ios | auth / operator | server | vitest | partial (7b) | npm builds report `manual_update` targets and apply/force/clear_lock answer 501; checkpoint 9 revisits with the npm release channel |
| R-M13 | `POST /api/talaria/relay/pair`, `POST /api/talaria/presence` | browser, ios | auth | server | vitest, fixture | pending | |
| R-M14 | `POST /api/transcribe`, `GET /api/transcribe/capability`, `POST /api/tts` | browser, ios | auth | server + sidecar (STT) | vitest | ported (7b) | Edge TTS engine dropped (503); openai/elevenlabs proxied with 30 s timeout and 2 s per-client limit |
| R-M15 | `POST /api/csp-report`, `POST /api/client-events/log` | browser | public / auth | server | vitest | ported (7b) | |
| R-M16 | Non-API: SPA shell allowlist, `/assets/*`, `/static/*`, `/static/dist/*`, `/sw.js`, manifests, `/plugins/plugin.css`, `/dashboard-plugins/*`, plugin tab pages, `/session/static/*`, `/favicon.ico`, `/health`, OPTIONS | browser, ios (`/health`) | public / auth | server | vitest, pw | partial | checkpoint 4: shell, `/assets/*`, `/static/*` (fingerprint caching), `/static/dist/*`, `/sw.js`, manifests, `/session/static/*`, `/favicon.ico`, `/health`, OPTIONS in `app.ts`; plugin and dashboard-plugin pages land with checkpoint 7 |

## 3. SSE and long-lived endpoints

| ID | Stream | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| E1 | `GET /api/chat/stream`: event union (contracts), `id: <stream_id>:<seq>`, replay query precedence, journal replay, close set, 5 s heartbeat | server, contracts | vitest, pw | partial | checkpoint 6: event ids `<stream_id>:<seq>`, `after_event_id`/`after_seq`/`Last-Event-ID` precedence, journal replay, close set, 5 s heartbeat; `metering` ticks and `todo_state` frames pending |
| E2 | `GET /api/sessions/events`: `sessions_changed`, `gateway_status`, 250 ms drain | server, contracts | vitest | partial | checkpoint 6: `sessions_changed` with the `stream` discriminator; the gateway half reports `watcher not started` until the profile domain lands |
| E3 | `GET /api/approval/stream`, `GET /api/clarify/stream`: `initial` + event, queue 16 | server, contracts | vitest | pass | checkpoint 6 |
| E4 | `GET /api/terminal/output`: `output`, `terminal_closed`, `terminal_error`, integer ids, backlog replay | server, contracts | vitest | pass | checkpoint 7c: `api/automation-raw.ts` |
| E5 | `GET /api/kanban/events/stream`: `hello`, `events`, cursor, 15 s heartbeat | server, contracts | vitest | pass | checkpoint 7c |
| E6 | Shared: stream slot claim, 503 `client_stream_limit`, `X-Accel-Buffering: no`, chunked env, write deadline, `Connection: close` | server | vitest | partial | checkpoint 6: slot claim with 503 `client_stream_limit` (`HERMES_WEBUI_MAX_SSE_CLIENTS`), `X-Accel-Buffering: no`, `Connection: close` on the chat relay; chunked env and write deadline pending |
| E7 | Long non-SSE: folder zip streaming, TTS proxy 30 s, extension sidecar proxy 10 s / 512 KiB | server | vitest | pending | |

## 4. Persistent state

| ID | State | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| P1 | `sessions/<sid>.json`: Session schema and key order, `.tmp.<pid>.<tid>` atomic write, `.bak` shrink rules, metadata-only stubs | server | fixture | partial | byte-identical rewrite of Python-produced fixtures; checkpoint 5a: `Session.toDocument()` key order, `.tmp.<pid>.<n>` + fsync + rename, `.bak` shrink guard, metadata-only prefix reads |
| P2 | `sessions/_index.json`, tombstone files, `_drafts/`, `_run_journal/`, `_turn_journal/` | server | fixture | partial | checkpoint 5a: `_index.json` incremental patch/prune, `_deleted_webui_sessions.json`, `_drafts/`; journals land with checkpoint 6; checkpoint 6 adds `_run_journal/<sid>/<stream>.jsonl` (contiguous seq, fsync on terminal rows, pruned summaries read); `_turn_journal/` pending |
| P3 | `settings.json` (defaults, allowlist, migrations, `password_hash`, mode-preserving atomic write), `projects.json`, `workspaces.json`, `last_workspace.txt`, per-profile `webui_state/` | server | fixture | partial | checkpoint 4: `settings.json` store with defaults, migrations, validation, and the mode-preserving atomic writer (`settings.ts`, `fs/atomic.ts`); the other files land with their domains; checkpoint 5a adds `projects.json`, `workspaces.json`, `last_workspace.txt`, per-profile `webui_state/` |
| P4 | Auth files: `.signing_key`, `.pbkdf2_key`, `.sessions.json`, `.login_attempts.json`, `passkeys.json`, `.passkey_challenges.json`, `.quota_scope_id` | server | fixture | pending | |
| P5 | `shares/`, `models_cache*.json`, `media_snapshots/`, `attachments/`, extension files, `sidecar-auth/`, `talaria-relay.json` + PEM + revision, `bootstrap-<port>.log` | server | fixture | partial | checkpoint 5a: `shares/`; the rest land with their domains; checkpoint 5b: `attachments/` inbox and the read side of `media_snapshots/` |
| P6 | Hermes home file formats read/written by the server: `config.yaml` (mode/uid/gid-preserving write, personality strip), `.env`, `auth.json`, `active_profile`, profile dirs, `saved_prompts.json`, skills `SKILL.md`, memories, `sessions.json`, gateway state, logs, cost snapshots, checkpoints, plugin manifests, Claude/Codex imports | server | fixture | pending | |
| P7 | `state.db` read-only projection via `better-sqlite3` (sidebar rows, json content decoding, schema probing, WAL fingerprint, index creation) | server | fixture | pending | |
| P8 | `state.db` writes (`SessionDB`, `delete_cli_session`) and kanban SQLite | sidecar | pytest | pending | |
| P9 | In-memory registries and lock ordering re-expressed for the event loop | server | vitest | pending | `docs/lock-ownership.md` rewritten |

## 5. Cryptography

| ID | Primitive | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| X1 | PBKDF2-HMAC-SHA256 600 000 iterations, `.pbkdf2_key` salt, legacy `.signing_key`-salted verify and re-hash | server | fixture | pending | |
| X2 | HMAC-SHA256 cookie, profile, CSRF signatures | server | fixture | pending | |
| X3 | WebAuthn ES256 with minimal CBOR, rpIdHash, UP flag, counter, SPKI PEM | server | fixture | pending | |
| X4 | OIDC JWT verification (RS/ES 256/384/512), JOSE to DER, JWKS cache, claims, PKCE S256, native one-time codes, session fingerprint, profile identity | server | fixture, vitest | pending | |
| X5 | Ed25519 relay signing, PKCS8 PEM | server | fixture | pending | `contracts/fixtures/publisher-snapshot.json` |
| X6 | `secrets.token_urlsafe` equivalents | server | vitest | pending | |

## 6. Background workers

| ID | Worker | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| W1 | Gateway watcher per profile home | server | vitest | pending | |
| W2 | bg-task-complete drain, wakeup turns, circuit breaker | server + sidecar | vitest, pytest | pending | |
| W3 | Session-channel reaper and hygiene tick (log rotation, spawn reaping, journal retention) | server | vitest | pending | |
| W4 | Talaria relay publisher (queue, wake, backoff, presence leases) | server | vitest, fixture | pending | |
| W5 | Request-diagnostics watchdog, terminal idle reaper, models-catalog rebuild, session index and list cache rebuild, `state.db` index priming | server | vitest | pending | |
| W6 | Per-turn checkpoint and metering ticker, memory-commit drains, MCP health probes, OAuth device-flow pollers, account-usage probes, title and manual-compress workers, cron run tracking, self-update restart scheduler | server (+sidecar where noted in TAL-245 §6) | vitest, pytest | pending | |

## 7. Subprocesses and PTY

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| S1 | Hardened git runner and workspace git info, worktrees, rollback checkpoints, release/update git ops | server | vitest (synthetic repos) | pending | |
| S2 | Desktop integrations (`open -R`, `xdg-open`, VS Code discovery with container path rewrite), prefill script | server | vitest | pending | |
| S3 | Gateway lifecycle via `hermes` CLI | sidecar | pytest | pending | |
| S4 | PTY terminal via `node-pty` (shell selection, env allowlist, resize clamp, backlog, cap, kill escalation, idle reap, close-all) | server | vitest | pass | checkpoint 7c: `tools/terminal.ts`; kill escalation SIGHUP → SIGKILL after 1.5 s |
| S5 | Cron execution child process | sidecar | pytest | pending | |

## 8. External HTTP integrations

| ID | Integration | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| N1 | Agent API server health and capabilities probe, dashboard probe | server | vitest | pending | |
| N2 | Talaria Relay pairing/redeem/snapshot/presence (protocol v2) | server | vitest, fixture | pending | |
| N3 | GitHub releases manifest client, extension registry and zip install | server | vitest | pending | |
| N4 | OIDC discovery/JWKS/token, OpenAI Codex device flow | server | vitest | pending | |
| N5 | Provider quota/cost, model catalogs with SSRF checks, TTS (ElevenLabs, OpenAI), Joplin notes, MCP health probe | server (+sidecar for `agent.account_usage`) | vitest | pending | |
| N6 | Extension sidecar proxy | server | vitest | pending | |
| N7 | Gateway chat backend (`HERMES_WEBUI_CHAT_BACKEND=gateway`) | server | vitest | pending | |

## 9. Sidecar-wrapped Agent capabilities

See `sidecar-rpc.md` for the method surface. Each row is one RPC namespace.

| ID | Namespace | Python source today | Verification | Status | Notes |
|---|---|---|---|---|---|
| A1 | `chat.*` (turn, interrupt, agent cache, compression hooks, context scoping, fail-closed profile rules) | `api/streaming.py`, `api/session_lifecycle.py` | pytest, vitest (fake) | pending | |
| A2 | `approval.*`, `clarify.*` | `api/route_approvals.py`, `api/clarify.py` | pytest | pending | |
| A3 | `goals.*` | `api/goals.py` | pytest | pending | |
| A4 | `cron.*` | `api/routes.py` (cron section) | pytest | pending | |
| A5 | `profiles.*` | `api/profiles.py` | pytest | pending | |
| A6 | `commands.*`, `plugins.*` | `api/commands.py`, `api/plugins.py`, `api/plugin_providers.py` | pytest | pending | |
| A7 | `skills.*` | `api/routes.py` (skills section), `api/skill_usage.py` | pytest | pending | |
| A8 | `providers.*`, `models.*` | `api/config.py`, `api/providers.py` | pytest | pending | |
| A9 | `aux.*` (auxiliary LLM, titles, summaries, compression feedback) | `api/streaming.py`, `api/reasoning_titles.py`, `api/compression_anchor.py` | pytest | pending | |
| A10 | `metadata.*` (context length, token estimates, models.dev), `redact`, `image_routing`, `portal_tags` | `api/helpers.py`, `api/message_window.py` | pytest | pending | |
| A11 | `stt.*` | `api/routes.py` (transcribe) | pytest | pending | |
| A12 | `mcp.*` | `api/mcp_health.py`, `api/routes.py` | pytest | pending | |
| A13 | `process.*` (process registry, async delegation drain) | `api/background.py`, `api/process_event_utils.py` | pytest | pending | |
| A14 | `state_db.*` (`SessionDB` writes, `delete_cli_session`), `kanban.*` | `api/state_sync.py`, `api/webui_session_db.py`, `api/kanban_bridge.py` | pytest | pending | |
| A15 | `usage.*` (account usage), `gateway.*` (lifecycle CLI, status), `runtime.*` (handshake, drift guard, Agent pin) | `api/usage.py`, `api/gateway_restart.py`, `api/agent_runtime.py` | pytest | pending | |

## 10. Frontend

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| U1 | Contract client replaces `api/endpoints.ts` and `api/client.ts` transport (CSRF, dedupe, retry, timeouts, 401 redirect, subpath) | frontend, contracts | vitest | pending | |
| U2 | `src/contracts/*` move into the contracts package; SSE consumers use the contract unions | frontend, contracts | vitest | pending | |
| U3 | Dead endpoint functions and `beacon()` removed; §2 mismatches fixed | frontend | vitest | pending | |
| U4 | `adapters/memory.ts` as contract-driven in-memory server for tests | frontend | vitest | pending | |
| U5 | Persisted keys, extension protocol v1, service worker, PWA, i18n, build scripts unchanged except path moves | frontend | vitest, ci | pending | |
| U6 | Vite dev proxy and e2e `server.ts` target the TS server | frontend | pw | pending | |

## 11. Launch and distribution

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| L1 | `talaria-web` CLI: `.env` precedence, Agent/venv discovery, sidecar preflight, optional Agent install, health wait, supervisor detection, detached start, browser open | server | vitest | pending | |
| L2 | `talaria-web ctl start|stop|restart|status|logs` with the same pid/log/env files and guards, `--remote` | server | vitest | pending | |
| L3 | WSL autostart script, supervisor units | docs | manual | pending | |
| L4 | Removal of Python launchers and packaging | dropped | ci | pending | Decisions table |
| L5 | Native Windows (`start.ps1`, pythonw restart, workflow), Nix flake and module | dropped | | dropped | Decisions table |

## 12. Docker

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| D1 | `node:24-slim` image with Python runtime for the Agent venv; user, UID/GID detection, seeding, deps marker, healthcheck, provenance label, GHCR identity, compose env forwarding | server | docker | pending | |
| D2 | Two/three-container variants with read-only `hermes-agent-src` mount | server | docker | pending | |

## 13. Self-update and provenance

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| V1 | Channels, release-set manifest resolution, checkout validation, clean-tree, fetch/ancestry/ff-only, `_release.json` stamping, running-code identity, restart-when-safe via re-exec | server | vitest (synthetic release sets, `file://` remotes) | pending | |
| V2 | Agent update and gateway restart | sidecar | pytest | pending | |
| V3 | Health `release` block without `upstreamBase`; release tooling scripts updated | server, tooling | ci | pending | |

## 14. CI and repository tooling

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| T1 | `web-verify.yml` Node 24 jobs, OpenAPI diff gate, sidecar pytest against the pinned Agent, `static/dist` gate, Playwright | tooling | ci | pending | |
| T2 | `changed-components.py` routing for `web/packages/**`, `web/sidecar/**`; `scripts/check`, `check-web-server` | tooling | ci (`--self-test`) | pending | |
| T3 | Workflow removals (`web-native-windows-startup.yml`, `upstream-watch.yml`), `actionlint`, `git diff --check` | tooling | ci | pending | |
| T4 | App contract runner boots the TS server; kanban reference server repointed at the sidecar | tooling | ci | pending | |

## 15. Tests

| ID | Coverage | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| Q1 | Contracts: schema and fixture tests, OpenAPI snapshot, monorepo `contracts/fixtures` tests | contracts | vitest | pending | |
| Q2 | Server: unit tests with fake sidecar, HTTP integration tests, SSE lifecycle, auth/CSRF/cookie/proxy, state-file and crypto compatibility fixtures, git runner, terminal, update, Docker invariants | server | vitest | pending | |
| Q3 | Sidecar pytest per RPC method | sidecar | pytest | pending | |
| Q4 | Frontend Vitest and Playwright | frontend | vitest, pw | pending | |
| Q5 | Regression-port rule: every `test_issue*.py` and `test_regressions.py` case ported by name or listed as dropped with reason | all | ci | pending | Counts reported in the PR body |

## 16. Documentation

| ID | Document set | Status | Notes |
|---|---|---|---|
| G1 | `web/` READMEs, `ARCHITECTURE.md`, `TESTING.md`, `CONTRIBUTING.md`, `AGENTS.md` | pending | |
| G2 | `docs/*.md` operational guides (troubleshooting, supervisor, onboarding checklist, docker, updates, WSL, chat setup, remote access, extensions) | pending | |
| G3 | Architecture and RFC documents (agent API contract, source boundary, frontend migration, SSE and run-adapter RFCs, lock ownership) | pending | |
| G4 | Root `README.md`, `CONTRACT_TESTS.md`, `docs/monorepo-migration.md`, changelog fragment | pending | |

## 17. Consumers to keep green

| ID | Consumer | Verification | Status | Notes |
|---|---|---|---|---|
| K1 | iOS app (`app/scripts/validate-upstream-contract`, `scripts/check-previous-app.py`) | ci | pending | |
| K2 | MCP bin (login, rename, move) | vitest | pending | |
| K3 | Extension SDK v1 and sidecar proxy sample | vitest, pw | pending | |
| K4 | Relay publisher contract fixture | vitest | pending | |
| K5 | `contracts/versions.json` and `contract_versions.json` parity | ci | pending | |
