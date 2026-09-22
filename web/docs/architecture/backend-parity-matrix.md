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
| H5 | Trusted proxy resolution (CIDRs, XFF walk, `X-Real-IP`), local-origin gate for onboarding/terminal, request base URL for OIDC | `api/helpers.py`, `api/auth.py` | server | vitest | pass | checkpoint 4: trusted proxy CIDRs, XFF walk, `X-Real-IP` (`http/origin.ts`); 7a: local-origin gate; 7d: validated/effective request host and OIDC base URL (`api/auth-raw.ts`) |
| H6 | TLS (cert/key, min 1.2, HTTP fallback), bind host/port/IPv6, refuse-to-start when `/health` already answers | `server.py` | server | vitest | pass | checkpoint 4: `server.ts` (TLS 1.2+, HTTP fallback, `isAlreadyServing` probe) |
| H7 | Worker budget: observable limits (8 streams per client identity, 503 `request_worker_capacity` / `client_stream_limit`), handler idle timeout, keepalive | `api/http_server.py` | server | vitest | pass | `StreamSlots` caps concurrent streams per client identity (`HERMES_WEBUI_MAX_SSE_CLIENTS`, default 8) with 503 `client_stream_limit`; request concurrency is the event loop, so the 128-handler split has no Node equivalent |
| H8 | Rate limits: login 5/60 s persisted, CSP report, client events, native OIDC start, passkey | `api/auth.py`, `api/routes.py` | server | vitest, fixture | pass | `.login_attempts.json` format preserved; checkpoint 4: login limiter; 7b: CSP report and client events; 7d: native OIDC start 10/60 s per (forwarded) client IP and the passkey challenge limiter (`PasskeyRateLimitError`) |
| H9 | JSON envelope: gzip above 1 KiB, `no-store`, weak ETag/304; error envelope `{error, code?}` and variants (`condition`, `replaced_by`, health 503 payload) | `api/helpers.py` | server, contracts | vitest | partial | checkpoint 4: gzip/`no-store`/weak ETag in `http/context.ts`; oRPC error bodies mapped to `{error}` (`api/router.ts`); health 503 payload via `RawResponse` |
| H10 | Body limits: 20 MiB read cap, multipart parser (`HERMES_WEBUI_MAX_UPLOAD_MB`), folder zip limits | `api/upload.py`, `api/helpers.py` | server | vitest | pass | 20 MiB JSON body cap (`readJsonBody`), multipart parser with `HERMES_WEBUI_MAX_UPLOAD_MB`, folder-zip limits (`workspace/upload.ts`, `zip.ts`) |
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
| R-A4 | `GET /api/auth/oidc/start`, `GET /api/auth/oidc/callback` | browser, ios | public | server | vitest | pass | checkpoint 7d (`api/auth-raw.ts`, `auth/oidc.ts`): raw 302 routes with `Cache-Control: no-store`; discovery/JWKS/token through `deps.fetch` with the private-host guard; a sidecar outage keeps the last resolved config instead of failing closed (Python re-reads YAML directly) |
| R-A5 | `POST /api/auth/oidc/native/start|exchange|cancel` | ios | public | server | vitest | pass | checkpoint 7d: S256 PKCE, `talaria://oidc-callback` schemes, one-time 60 s exchange codes, HttpOnly/Secure cookie in the exchange response |
| R-A6 | `POST /api/auth/passkey/options|login` | browser | public | server | vitest | pass | checkpoint 7d (`auth/passkeys.ts`): ES256 only, stdlib CBOR, rpId/origin from `Origin` else `Host`, counter regression check, `passkeys.json` 0600 |
| R-A7 | `POST /api/auth/passkey/register/options|register|delete`, `GET /api/auth/passkeys` | browser | operator | server | vitest | pass | checkpoint 7d: owner session or the local first-run gate; last passkey without a password answers 409; list answers `credentials` and register reads `label` like Python (frontend sends `name` and reads `passkeys`: checkpoint 8) |

### 2b. Sessions

| ID | Route | Consumers | Auth | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| R-S1 | `GET /api/sessions`, `GET /api/sessions/search` | browser, ios | auth | server | vitest, fixture, pw | partial | checkpoint 5a: list/search with ETag/304, `show_*_sessions`, `archived_limit/offset`; 7f: state.db rows merged (`sessions/cli-sessions.ts`, `list.ts`): metadata backfill, lineage dedupe, messaging latest-per-identity via `sessions/sessions.json`, CLI cap 20, cron/webhook/kanban passes; not ported: orphaned-sidecar prune (#3238/#4985), Claude Code imports, all-profiles state.db fan-out, cron/webhook project chips (`project_id: null`), `expand_renderable` |
| R-S2 | `GET /api/session`, `GET /api/session/status`, `GET /api/session/usage`, `GET /api/session/export` | browser, ios | auth | server | vitest, fixture | pass | checkpoint 5a: `GET /api/session|status|usage` with the bounded message window (`sessions/window.ts`); `export` lands with 5b; checkpoint 5b: `GET /api/session/export` (JSON and self-contained HTML via `text/markdown.ts`) as a raw pipeline route |
| R-S3 | `POST /api/session/new|rename|delete|pin|archive|move|duplicate|branch|truncate|undo|retry|clear|update` | browser, ios, mcp | auth | server | vitest | partial | `delete` state.db cleanup via sidecar; checkpoint 5a: all mutations in `sessions/service.ts`; state.db cleanup and journal-backed recovery pending |
| R-S4 | `POST /api/session/title/regenerate`, `POST /api/session/import`, `POST /api/session/import_cli` | browser, ios | auth | server (+sidecar for titles) | vitest | partial | checkpoint 5a: `import`; 8: `title/regenerate` through `TurnRunner.generateTitle` (first complete pair scanning past queued user rows, `prefer_latest`, sidecar `aux.complete`, local fallback, 422 when nothing better); `import_cli` needs state.db message decoding (R-S2) |
| R-S5 | `GET|POST /api/session/yolo`, `POST /api/session/toolsets` | browser, ios | auth | server | vitest | partial | checkpoint 5a: yolo is process-local, toolsets validated and persisted |
| R-S6 | `POST /api/session/compress`, `POST /api/session/compress/start`, `GET /api/session/compress/status`, `POST /api/session/handoff-summary` | browser, ios | auth | server + sidecar | vitest, pytest | partial | checkpoint 8: `compress/start` answers 501 `manual_compression_unavailable` (409 while streaming) and `compress/status` answers `idle`, so the browser flow fails cleanly; the Agent-side manual compression worker needs a sidecar method (checkpoint 10 decision) |
| R-S7 | `POST /api/session/draft` | browser | auth | server | vitest, fixture | pass | monotonic `_draft_version`; checkpoint 5a: `sessions/drafts.ts`, 409 with the current draft on stale versions |
| R-S8 | `GET /api/session/worktree/status`, `POST /api/session/worktree/remove` | browser | auth | server | vitest | pass | checkpoint 5b: `workspace/worktrees.ts`; creation goes through the new sidecar `worktree.create` (Agent `_setup_worktree`) |
| R-S9 | `POST /api/sessions/cleanup_zero_message` | browser | auth | server | vitest | pass | checkpoint 5a |
| R-S10 | `GET /api/sessions/events` | browser | auth | server | vitest | pass | checkpoint 6: session half; 7f: `?gateway=1` merges the watcher feed with the `stream` discriminator and a 250 ms drain plus the `gateway_status` probe payload; the standalone `GET /api/sessions/gateway/stream` stays dropped (no consumer) |
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
| R-M8 | `GET /api/insights`, `GET /api/logs`, `GET /api/system/health`, `GET /api/health/agent`, `POST /api/health/restart`, `GET /api/dashboard/status`, `POST /api/shutdown` | browser, ios | auth / operator | server (+sidecar for agent restart) | vitest | partial (7b, 7h) | Insights skip the state.db CLI merge; agent health probes remote gateways and local pid/state files (7h); system health uses loadavg/statfs |
| R-M9 | `GET|POST /api/dashboard/config`, `GET /api/project-os/dashboard`, `POST /api/admin/reload`, `GET /api/gateway/status`, `POST /api/gateway/start|stop|restart`, `/search`, `/v1` | none | | dropped | | dropped | |
| R-M10 | `GET /api/mcp/servers|tools`, `POST /api/mcp/servers/<name>` actions | browser | auth | server + sidecar | vitest | partial (7b, 7h) | PATCH/PUT/DELETE kept alongside the POST action body; 7h: demand-driven health prober (`tools/mcp-health.ts`: initialize probe with session DELETE, fingerprint-keyed verdicts, 120 s interval, ≤4 in flight, 8 s timeout, stdio `which` check) |
| R-M11 | `GET /api/plugins` | browser | auth | server + sidecar | vitest | ported (7b) | Agent plugin visibility via `plugins.list`; WebUI dashboard plugins (`api/plugins.py`) dropped with the dashboard |
| R-M12 | `GET|POST /api/updates/check`, `POST /api/updates/apply|force|clear_lock|summary` | browser, ios | auth / operator | server | vitest | pass | checkpoint 9b (`tools/updates.ts`, `cli/supervise.ts`): `GET` answers the 30 min cache (`stale_channel`, `include_agent`); `POST` checks the Web checkout (stable: newest completed `release-set-<sha>` manifest through the GitHub API with the opt-in `TALARIA_RELEASE_TOKEN`, redirect allow-list, 2 MB cap, 15 s deadline; experimental: `fetch --no-tags origin/main` counting only `web/` and `contracts/` changes) and the Agent checkout (`v*` tags, branch fallback, `dirty`); apply validates the checkout (toplevel `/web`, `contracts/versions.json`, `web/package.json`, `maudecode/talaria` origin), refuses dirty trees and in-progress git operations, fetches only the immutable tag, `merge --ff-only --no-overwrite-ignore`, verifies and writes `_release.json` from git blobs (`metadata_repair` until the process restarts with that identity); the Agent path stashes, pulls `--ff-only`, force-resets on `/force`, and restarts the gateway through the sidecar with one retry; `clear_lock` never deletes locks (Web retries, Agent gets the manual `rm` command and an inventory); restart-blocked responses list active streams/runs; restart waits up to 300 s for active work, purges `__pycache__`, and exits with code 75 so the `talaria-web serve` supervisor respawns the worker; npm installs and unrecognized checkouts report `manual_update`; What's New summaries reuse the Python section format, git commit subjects, the optional `aux.complete` generator, and a 16-entry cache |
| R-M13 | `POST /api/talaria/relay/pair`, `POST /api/talaria/presence` | browser, ios | auth | server | vitest | pass | checkpoint 7e (`sessions/relay.ts`): owner registration, profile enrollment on the existing key, allowlisted relay origin, presence leases with strictly increasing `seq`; serialised pairing instead of a lock |
| R-M14 | `POST /api/transcribe`, `GET /api/transcribe/capability`, `POST /api/tts` | browser, ios | auth | server + sidecar (STT) | vitest | ported (7b) | Edge TTS engine dropped (503); openai/elevenlabs proxied with 30 s timeout and 2 s per-client limit |
| R-M15 | `POST /api/csp-report`, `POST /api/client-events/log` | browser | public / auth | server | vitest | ported (7b) | |
| R-M16 | Non-API: SPA shell allowlist, `/assets/*`, `/static/*`, `/static/dist/*`, `/sw.js`, manifests, `/plugins/plugin.css`, `/dashboard-plugins/*`, plugin tab pages, `/session/static/*`, `/favicon.ico`, `/health`, OPTIONS | browser, ios (`/health`) | public / auth | server | vitest, pw | partial | checkpoint 4: shell, `/assets/*`, `/static/*` (fingerprint caching), `/static/dist/*`, `/sw.js`, manifests, `/session/static/*`, `/favicon.ico`, `/health`, OPTIONS in `app.ts`; plugin and dashboard-plugin pages land with checkpoint 7 |

## 3. SSE and long-lived endpoints

| ID | Stream | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| E1 | `GET /api/chat/stream`: event union (contracts), `id: <stream_id>:<seq>`, replay query precedence, journal replay, close set, 5 s heartbeat | server, contracts | vitest, pw | partial | checkpoint 6: event ids `<stream_id>:<seq>`, `after_event_id`/`after_seq`/`Last-Event-ID` precedence, journal replay, close set, 5 s heartbeat; 8: the event union lives in the contracts package (`sse.ts`); `metering` ticks and `todo_state` frames pending |
| E2 | `GET /api/sessions/events`: `sessions_changed`, `gateway_status`, 250 ms drain | server, contracts | vitest | pass | checkpoint 6: `sessions_changed` with the `stream` discriminator; 7f: gateway half backed by `GatewayWatcherRegistry` (watcher stop ends the response so EventSource reconnects) |
| E3 | `GET /api/approval/stream`, `GET /api/clarify/stream`: `initial` + event, queue 16 | server, contracts | vitest | pass | checkpoint 6 |
| E4 | `GET /api/terminal/output`: `output`, `terminal_closed`, `terminal_error`, integer ids, backlog replay | server, contracts | vitest | pass | checkpoint 7c: `api/automation-raw.ts` |
| E5 | `GET /api/kanban/events/stream`: `hello`, `events`, cursor, 15 s heartbeat | server, contracts | vitest | pass | checkpoint 7c |
| E6 | Shared: stream slot claim, 503 `client_stream_limit`, `X-Accel-Buffering: no`, chunked env, write deadline, `Connection: close` | server | vitest | partial | checkpoint 6: slot claim with 503 `client_stream_limit` (`HERMES_WEBUI_MAX_SSE_CLIENTS`), `X-Accel-Buffering: no`, `Connection: close` on the chat relay; chunked env and write deadline pending |
| E7 | Long non-SSE: folder zip streaming, TTS proxy 30 s, extension sidecar proxy 10 s / 512 KiB | server | vitest | pass | folder zip streaming (`workspace/zip.ts`), TTS proxy with a 30 s timeout (`api/tools-raw.ts`), extension sidecar proxy with the 10 s / 512 KiB caps (`tools/extensions.ts`) |

## 4. Persistent state

| ID | State | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| P1 | `sessions/<sid>.json`: Session schema and key order, `.tmp.<pid>.<tid>` atomic write, `.bak` shrink rules, metadata-only stubs | server | fixture | pass | `Session.toDocument()` key order and `.tmp.<pid>` atomic writes; the continuity proof (`src/test/continuity.test.ts`) saves Python-written sessions back byte for byte apart from the shared draft overlay |
| P2 | `sessions/_index.json`, tombstone files, `_drafts/`, `_run_journal/`, `_turn_journal/` | server | fixture | partial | checkpoint 5a: `_index.json` incremental patch/prune, `_deleted_webui_sessions.json`, `_drafts/`; journals land with checkpoint 6; checkpoint 6 adds `_run_journal/<sid>/<stream>.jsonl` (contiguous seq, fsync on terminal rows, pruned summaries read); `_turn_journal/` pending |
| P3 | `settings.json` (defaults, allowlist, migrations, `password_hash`, mode-preserving atomic write), `projects.json`, `workspaces.json`, `last_workspace.txt`, per-profile `webui_state/` | server | fixture | pass | defaults, allowlist, migrations, `password_hash`, mode-preserving atomic write; the continuity proof keeps keys, order, and values of a Python-written `settings.json` (floats serialise as `1` instead of `1.0`) |
| P4 | Auth files: `.signing_key`, `.pbkdf2_key`, `.sessions.json`, `.login_attempts.json`, `passkeys.json`, `.passkey_challenges.json`, `.quota_scope_id` | server | vitest | pass | signing/PBKDF2 keys, `.sessions.json` (incl. OIDC-bound records), `.login_attempts.json`, `passkeys.json`, `.passkey_challenges.json`; Python-written files verified by the continuity proof |
| P5 | `shares/`, `models_cache*.json`, `media_snapshots/`, `attachments/`, extension files, `sidecar-auth/`, `talaria-relay.json` + PEM + revision, `bootstrap-<port>.log` | server | fixture | partial | checkpoint 5a: `shares/`; 5b: `attachments/` inbox and the read side of `media_snapshots/`; 7c: extension files; 7e: `talaria-relay.json` (v2, sorted keys), `talaria-relay-publisher-<hash>.pem`, `talaria-relay-revision`, per-profile `.talaria-relay-profile-id`; `sidecar-auth/` and `bootstrap-<port>.log` later |
| P6 | Hermes home file formats read/written by the server: `config.yaml` (mode/uid/gid-preserving write, personality strip), `.env`, `auth.json`, `active_profile`, profile dirs, `saved_prompts.json`, skills `SKILL.md`, memories, `sessions.json`, gateway state, logs, cost snapshots, checkpoints, plugin manifests, Claude/Codex imports | server | fixture | pass | `config.yaml` reads/writes with mode preservation (`config/agent-config.ts`), `.env` upsert (`providers/env-file.ts`), `auth.json` credential pools, `active_profile`, profile directories, `saved_prompts.json`, skills, memories, `gateway_state.json`/`gateway.pid`, logs, cost snapshots, checkpoints, plugin manifests, Claude Code imports, Codex cache fingerprint |
| P7 | `state.db` read-only projection (sidebar rows, json content decoding, schema probing, WAL fingerprint, index creation) | server | vitest | pass | `sessions/state-db.ts` on `node:sqlite` (stdlib; `better-sqlite3` was allowed but unnecessary): sidebar rows, `\x00json:` decoding, schema probing, WAL fingerprint |
| P8 | `state.db` writes (`SessionDB`, `delete_cli_session`) and kanban SQLite | sidecar | pytest | pass | sidecar `state_db.sync_start|sync_usage|sync_title|delete_cli_session` and `kanban.*` (`hermes_cli.kanban_db`) with pytest fixtures |
| P9 | In-memory registries and lock ordering re-expressed for the event loop | server | vitest | pass | `docs/lock-ownership.md` rewritten for the event-loop model; promise-based per-session, git, relay, update, and index serialization |

## 5. Cryptography

| ID | Primitive | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| X1 | PBKDF2-HMAC-SHA256 600 000 iterations, `.pbkdf2_key` salt, legacy `.signing_key`-salted verify and re-hash | server | fixture | pass | `auth/store.ts`: PBKDF2-HMAC-SHA256 600 000 iterations salted with `.pbkdf2_key`, legacy `.signing_key`-salted hashes verified and re-hashed (fixture values from `api/auth.py` at db3f02679 in `auth/store.test.ts`) |
| X2 | HMAC-SHA256 cookie, profile, CSRF signatures | server | fixture | pass | cookie, profile, and CSRF HMAC layouts byte-compatible with the Python fixtures (`auth/store.test.ts`); the continuity proof logs in with a Python-issued cookie |
| X3 | WebAuthn ES256 with minimal CBOR, rpIdHash, UP flag, counter, SPKI PEM | server | fixture | pass | `auth/passkeys.ts`: ES256/P-256, minimal CBOR, rpIdHash, UP flag, counter rule, SPKI PEM storage; `api/auth-flows.test.ts` drives a fake authenticator |
| X4 | OIDC JWT verification (RS/ES 256/384/512), JOSE to DER, JWKS cache, claims, PKCE S256, native one-time codes, session fingerprint, profile identity | server | vitest | pass | checkpoint 7d: `node:crypto` JWK import, ES signatures verified as `ieee-p1363` (no DER conversion needed), 5 min discovery/JWKS cache with one forced refresh on unknown `kid`, canonical-JSON policy fingerprint, `dev:ino` profile identity; stale bindings invalidate the session on the next request |
| X5 | Ed25519 relay signing, PKCS8 PEM | server | vitest | pass | checkpoint 7e: `node:crypto` Ed25519 keys, PKCS8 PEM at 0600, `METHOD\npath\ntimestamp\nnonce\nsha256(body)` signature verified in `relay.test.ts`; snapshot shape matches `contracts/fixtures/publisher-snapshot.json` |
| X6 | `secrets.token_urlsafe` equivalents | server | vitest | pass | `crypto.randomBytes` base64url tokens for shares, sidecar auth, uploads |

## 6. Background workers

| ID | Worker | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| W1 | Gateway watcher per profile home | server | vitest | pass | checkpoint 7f (`sessions/gateway-watcher.ts`): 5 s poll, fingerprint skip, 300 s parity pass, bounded subscriber queues with slow-consumer sentinel, per-home registry with atomic restart; started lazily by the SSE routes |
| W2 | bg-task-complete drain, wakeup turns, circuit breaker | server + sidecar | vitest, pytest | partial | checkpoint 7h (`sessions/completions.ts`): 1 s `process.drain` poll, exact-owner routing (`origin_ui_session_id` over `session_key`), per-session dedupe, coalesced `bg_task_complete` + `process_complete` on session channels and live streams, server-side `process_wakeup` turns, deferred delivery at turn teardown with a 24 k-char batch and a 5 × 30 s retry budget, `mark_consumed` on acceptance; async delegations are requeued when unroutable (durable claim/ACK lifecycle not ported), compression-lineage following and the credential-pause 409 (`process_wakeup_paused`) are not ported |
| W3 | Session-channel reaper and hygiene tick (log rotation, spawn reaping, journal retention) | server | vitest | partial | checkpoint 7h (`tools/hygiene.ts`): 60 s tick with copy-truncate log rotation (`HERMES_WEBUI_LOG_FILE` / `bootstrap-<port>.log`, `HERMES_WEBUI_LOG_MAX_BYTES`) and 6 h run-journal retention (`RunJournal.pruneSettled`, 14 d / keep 3, live writers skipped); session channels close on the last unsubscribe so no reaper is needed; detached-spawn reaping and turn-journal retention are not ported (no detached spawns, `_turn_journal/` pending) |
| W4 | Talaria relay publisher (queue, wake, backoff, presence leases) | server | vitest | pass | checkpoint 7e: coalescing dirty flag + 60 s wake loop, 5 s..300 s jittered backoff, permanent HTTP isolates one profile, `alertEligible` downgrade on rejection, 15 min terminal retention, revision floor file; started by the `talaria-web` bin after listen (checkpoint 9 launcher owns lifecycle) |
| W5 | Request-diagnostics watchdog, terminal idle reaper, models-catalog rebuild, session index and list cache rebuild, `state.db` index priming | server | vitest | partial | terminal idle reaper (`tools/terminal.ts`) and gateway watcher registry ported; the request-diagnostics watchdog and the out-of-band models-catalog rebuild are not (catalog builds run on demand with the same TTL) |
| W6 | Per-turn checkpoint and metering ticker, memory-commit drains, MCP health probes, OAuth device-flow pollers, account-usage probes, title and manual-compress workers, cron run tracking, self-update restart scheduler | server (+sidecar where noted in TAL-245 §6) | vitest, pytest | partial | 7h: MCP health probes; 6: title worker; the rest pending |

## 7. Subprocesses and PTY

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| S1 | Hardened git runner and workspace git info, worktrees, rollback checkpoints, release/update git ops | server | vitest (synthetic repos) | pass | `workspace/git.ts` (`-c` isolation, env scrub, `GIT_TERMINAL_PROMPT=0`, timeouts, destructive gate), worktrees, rollback checkpoints, release git ops in `tools/updates.ts`, prefill script |
| S2 | Desktop integrations (`open -R`, `xdg-open`, VS Code discovery with container path rewrite), prefill script | server | vitest | pass | `open -R` / `xdg-open` and VS Code discovery with container path translation (`vscode` deps in `runtime.ts`) |
| S3 | Gateway lifecycle via `hermes` CLI | sidecar | pytest | pass | sidecar `gateway.restart` (`hermes gateway restart` with drain and 240 s wait); the server retries once after a transient failure |
| S4 | PTY terminal via `node-pty` (shell selection, env allowlist, resize clamp, backlog, cap, kill escalation, idle reap, close-all) | server | vitest | pass | checkpoint 7c: `tools/terminal.ts`; kill escalation SIGHUP → SIGKILL after 1.5 s |
| S5 | Cron execution child process | sidecar | pytest | pass | sidecar `cron.run` executes the job in a child process with timeouts |

## 8. External HTTP integrations

| ID | Integration | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| N1 | Agent API server health and capabilities probe, dashboard probe | server | vitest | partial | 7b: dashboard probe; 7h: remote gateway health walk (`/health/detailed` with the API key, `/health`, `/v1/health`, 2 s each, 5 s single-flight cache) and local `gateway.pid` + `gateway_state.json` freshness rules; the `/v1/capabilities` probe lands with the gateway chat backend |
| N2 | Talaria Relay pairing/redeem/snapshot/presence (protocol v2) | server | vitest | pass | checkpoint 7e: `publisher/redeem`, `profile/redeem`, `PUT .../snapshot` through `deps.fetch` with 10 s timeouts; v1 or malformed relay responses answer 502 without persisting |
| N3 | GitHub releases manifest client, extension registry and zip install | server | vitest | pass | `tools/updates.ts` GitHub release-set client (redirect allow-list, token, 2 MB cap); extension registry and zip install in `tools/extensions.ts` (SHA-256, host allow-list, zip limits) |
| N4 | OIDC discovery/JWKS/token, OpenAI Codex device flow | server | vitest | partial | OIDC discovery/JWKS/token ported (checkpoint 7d); the OpenAI Codex device flow is not ported (onboarding OAuth answers 501, see R-P6) |
| N5 | Provider quota/cost, model catalogs with SSRF checks, TTS (ElevenLabs, OpenAI), Joplin notes, MCP health probe | server (+sidecar for `agent.account_usage`) | vitest | pass | `providers/*`: OpenRouter/DeepSeek/OpenCode/Codex quotas, catalogs with SSRF checks, ElevenLabs and OpenAI TTS (`api/tools-raw.ts`), STT through the sidecar, Joplin notes |
| N6 | Extension sidecar proxy | server | vitest | pass | consented extension sidecar proxy with header stripping, `X-Hermes-Sidecar-Token`, same-origin redirects, size cap (`tools/extensions.ts`, `api/automation-raw.ts`) |
| N7 | Gateway chat backend (`HERMES_WEBUI_CHAT_BACKEND=gateway`) | server | vitest | dropped (documented gap) | the gateway chat backend (`HERMES_WEBUI_CHAT_BACKEND=gateway`) is not ported; the server reports `gateway_chat: {enabled: false, backend: 'local'}` and chat always runs through the sidecar. Tracked as a follow-up in the PR body |

## 9. Sidecar-wrapped Agent capabilities

See `sidecar-rpc.md` for the method surface. Each row is one RPC namespace.

| ID | Namespace | Python source today | Verification | Status | Notes |
|---|---|---|---|---|---|
| A1 | `chat.*` (turn, interrupt, agent cache, compression hooks, context scoping, fail-closed profile rules) | `api/streaming.py`, `api/session_lifecycle.py` | pytest, vitest (fake) | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A2 | `approval.*`, `clarify.*` | `api/route_approvals.py`, `api/clarify.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A3 | `goals.*` | `api/goals.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A4 | `cron.*` | `api/routes.py` (cron section) | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A5 | `profiles.*` | `api/profiles.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A6 | `commands.*`, `plugins.*` | `api/commands.py`, `api/plugins.py`, `api/plugin_providers.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A7 | `skills.*` | `api/routes.py` (skills section), `api/skill_usage.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A8 | `providers.*`, `models.*` | `api/config.py`, `api/providers.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A9 | `aux.*` (auxiliary LLM, titles, summaries, compression feedback) | `api/streaming.py`, `api/reasoning_titles.py`, `api/compression_anchor.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A10 | `metadata.*` (context length, token estimates, models.dev), `redact`, `image_routing`, `portal_tags` | `api/helpers.py`, `api/message_window.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A11 | `stt.*` | `api/routes.py` (transcribe) | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A12 | `mcp.*` | `api/mcp_health.py`, `api/routes.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A13 | `process.*` (process registry, async delegation drain) | `api/background.py`, `api/process_event_utils.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A14 | `state_db.*` (`SessionDB` writes, `delete_cli_session`), `kanban.*` | `api/state_sync.py`, `api/webui_session_db.py`, `api/kanban_bridge.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |
| A15 | `usage.*` (account usage), `gateway.*` (lifecycle CLI, status), `runtime.*` (handshake, drift guard, Agent pin) | `api/usage.py`, `api/gateway_restart.py`, `api/agent_runtime.py` | pytest | pass | checkpoint 3: implemented in `sidecar/talaria_sidecar/methods/*`, schema in `packages/contracts/src/sidecar/namespaces.ts`, recorded fixtures under `packages/contracts/fixtures/sidecar/`, pytest in `sidecar/tests` |

## 10. Frontend

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| U1 | Contract client replaces `api/endpoints.ts` and `api/client.ts` transport (CSRF, dedupe, retry, timeouts, 401 redirect, subpath) | frontend, contracts | vitest | pass | checkpoint 8: `api/orpc.ts` builds `createORPCClient(new OpenAPILink(routeContract))` over `contractFetch` in `client.ts` (same transport seam, CSRF header, GET coalescing until the next mutation, 401 redirect, app-root subpath, `ApiError` envelope, 30 s default timeout with per-call `timeout()` signals); `request()` stays only for byte streams (multipart upload) |
| U2 | `src/contracts/*` move into the contracts package; SSE consumers use the contract unions | frontend, contracts | vitest | pass | checkpoint 8: response shapes live in `packages/contracts/src/views.ts` (typed known fields, documented catchall passthrough) and are the route outputs; `sse.ts` unions moved into the package; the frontend `src/contracts/*` files are re-exports plus frontend-only helpers (`ApiError`, persisted keys, URL search schemas, extension protocol); every captured live fixture parses with the package schemas |
| U3 | Dead endpoint functions and `beacon()` removed; §2 mismatches fixed | frontend | vitest | pass | checkpoint 8: 50 dead endpoint functions and `beacon()` deleted; projects use `project_id`; passkeys read `credentials`/`label`; `writeMemory` sends `section`; `switchProfile`/`deleteProfile` send one `name`; kanban actions are `patch|comments|block|unblock` plus the board-level `dispatch`; `ackProcessComplete`, `savePlugins`, `mcpServerAction` gone |
| U4 | `adapters/memory.ts` as contract-driven in-memory server for tests | frontend | vitest | pass | checkpoint 8: unchanged transport seam; the contract client runs against it in `client.test.ts` |
| U5 | Persisted keys, extension protocol v1, service worker, PWA, i18n, build scripts unchanged except path moves | frontend | vitest, ci | pass | checkpoint 8: untouched |
| U6 | Vite dev proxy and e2e `server.ts` target the TS server | frontend | pw | pass | checkpoint 8: `e2e/server.ts` spawns `packages/server/dist/bin/talaria-web.js` (building it on a fresh checkout); the dev proxy already targets `HERMES_WEBUI_DEV_PROXY` |

## 11. Launch and distribution

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| L1 | `talaria-web` CLI: `.env` precedence, Agent/venv discovery, sidecar preflight, optional Agent install, health wait, supervisor detection, detached start, browser open | server | vitest | pass | checkpoint 9a (`cli/dotenv.ts`, `cli/launcher.ts`, bin): checkout `.env` (unconditional, `HERMES_WEBUI_PRESERVE_ENV`) then `$HERMES_HOME/.env` fallback, `HERMES_WEBUI_NO_DOTENV`; discovery adds the `hermes` launcher walk-up; preflight runs `import yaml; from run_agent import AIAgent` on the venv; `install.sh --commit <pin>` (POSIX); supervisor env detection (launchd noise filtered) runs the server in-process instead of `execv`; detached start logs to `bootstrap-<port>.log`, waits for `/health` (HTTPS first, self-signed warning, HTTP fallback), prints the ready URL and opens the browser |
| L2 | `talaria-web ctl start|stop|restart|status|logs` with the same pid/log/env files and guards, `--remote` | server | vitest | pass | checkpoint 9a (`cli/ctl.ts`): `webui.pid`/`webui.log`/`webui.ctl.env` under the Hermes home (per-worktree runtime dir with the POSIX `cksum` id when the checkout is a git worktree, first free port from `HERMES_WEBUI_CTL_PORT_START`), launchd label and systemd unit guards with port scoping, foreign-responder guard, startup grace watch (`HERMES_WEBUI_START_GRACE`), owned-pid check through the state file, SIGTERM then SIGKILL, unmanaged-instance warnings, `status` health line, `logs` via `tail`, `start --remote` runs the Vite dev server against `HERMES_WEBUI_DEV_PROXY` |
| L3 | WSL autostart script, supervisor units | docs | manual | pass | checkpoint 9c: `scripts/wsl/hermes_webui_autostart.sh` runs the `talaria-web` bin; `docs/supervisor.md` and `docs/wsl-autostart.md` updated |
| L4 | Removal of Python launchers and packaging | dropped | ci | pass | checkpoint 10: `bootstrap.py`, `start.sh`, `start.ps1`, `ctl.sh`, `pyproject.toml`, `requirements*.txt`, `uv.lock`, `pytest.ini`, `scripts/test.sh`, `scripts/ruff_lint.py`, `flake.nix`, `nix/`, `scripts/windows/`, `mcp_server.py`, `api/`, `server.py`, `tests/` removed; `web/` has no Python outside `sidecar/` |
| L5 | Native Windows (`start.ps1`, pythonw restart, workflow), Nix flake and module | dropped | | dropped | Decisions table |

## 12. Docker

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| D1 | `node:24-slim` image with Python runtime for the Agent venv; user, UID/GID detection, seeding, deps marker, healthcheck, provenance label, GHCR identity, compose env forwarding | server | docker | partial (9c) | Dockerfile rewritten on `node:24-slim` (git, curl, rsync, OpenSSH, python3/venv, uv); `npm ci`/build/prune of the contracts and server workspaces in the image; `TALARIA_WEB_VERSION` replaces `api/_version.py`; the provenance label is checked against `release.ts`; SQLite-from-source, `hindsight-client`, and wheel dockerignore entries dropped. `docker_init.bash` keeps the UID/GID alignment, `/app` seeding, and `.deps_installed` semantics but builds the sidecar's Agent venv under `/app/hermes-agent-src` and execs the Node bin. The npm install/build/prune sequence was verified locally in a copy of the context; the image build and `scripts/check-docker.py` variants need the Docker daemon (CI `web-docker-smoke`) |
| D2 | Two/three-container variants with read-only `hermes-agent-src` mount | server | docker | partial (9c) | Compose files keep the read-only mount and env forwarding; comments describe the sidecar venv. Smoke pending on a Docker daemon |

## 13. Self-update and provenance

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| V1 | Channels, release-set manifest resolution, checkout validation, clean-tree, fetch/ancestry/ff-only, `_release.json` stamping, running-code identity, restart-when-safe via re-exec | server | vitest (synthetic release sets, `file://` remotes) | pass | checkpoint 9b: `tools/updates.ts` + `updates.test.ts` (63 cases porting `test_tal203_source_update.py` and `test_tal203_published_releases.py` by name); restart is exit code 75 handled by `cli/supervise.ts` |
| V2 | Agent update and gateway restart | sidecar | pytest | pass | checkpoint 9b: the Agent checkout follows its `v*` tags (fetch, stash/pull `--ff-only`, force reset with the rewind guard) in `tools/updates.ts`; the gateway restarts through the sidecar `gateway.restart` with one retry (vitest) |
| V3 | Health `release` block without `upstreamBase`; release tooling scripts updated | server, tooling | ci | pass | `ReleaseInfoSchema`, `release.ts`, the updater, and the OpenAPI document drop `upstreamBase`; `scripts/stamp-release.py` validates stamps without importing Web Python; `releases/plan.py`, `release-set.schema.json` (adds the optional `npm` identity), `build.py` (`npm pack` of contracts + server instead of the wheel), `publish.py` (tarball assets on the Web release and `npm publish` under the `web-release` environment with `NPM_TOKEN`), and `check-release-contracts.py` (contracts Vitest) updated; `web/UPSTREAM_BASE_SHA` removed; `scripts/check-releases` passes |

## 14. CI and repository tooling

| ID | Capability | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| T1 | `web-verify.yml` Node 24 jobs, OpenAPI diff gate, sidecar pytest against the pinned Agent, `static/dist` gate, Playwright | tooling | ci | pass | checkpoint 9c: `server` (lint, typecheck, Vitest, OpenAPI diff), `sidecar` (`scripts/check-agent-compatibility.py --skip-docker` provisions the pinned Agent and runs the sidecar suite), `frontend` (gates, `static/dist` diff, Playwright on the fixture replay sidecar via `scripts/check-web-browser`); Python lint/pytest jobs removed |
| T2 | `changed-components.py` routing for `web/packages/**`, `web/sidecar/**`; `scripts/check`, `check-web-server` | tooling | ci (`--self-test`) | pass | `web_python` suite removed; `web_server` owns `packages/server`, `sidecar/`, `scripts/`, `.env.example`; Docker paths include `scripts/lib/`; `scripts/check web` runs `check-web-server` (npm gates + OpenAPI diff + sidecar pytest) then the frontend gates and the browser suite |
| T3 | Workflow removals (`web-native-windows-startup.yml`, `upstream-watch.yml`), `actionlint`, `git diff --check` | tooling | ci | pass | both workflows, `scripts/import-web-upstream`, `scripts/test-monorepo-import.py`, and `web/UPSTREAM_BASE_SHA` removed; `critical_markdown_check.py` moved to `scripts/critical-markdown-check.py` with a unittest port; `rehearse-monorepo.py` tolerates the retired base file; `actionlint` and `git diff --check` pass |
| T4 | App contract runner boots the TS server; kanban reference server repointed at the sidecar | tooling | ci | pass | `app/scripts/validate-upstream-contract` builds the contracts/server workspaces (for `--ref` exports) and boots the Node bin on `HERMES_WEBUI_SIDECAR_COMMAND` = `sidecar/scripts/replay_sidecar.py` (fixture replay + staged approval); the probe's `inject_test` step became `POST /api/chat/start`; `--server-only` passes locally end to end. `verify_kanban_reference_server.py` boots the Node server with the real Agent sidecar and drives `/api/kanban/*` over HTTP with a password login |

## 15. Tests

| ID | Coverage | Owner | Verification | Status | Notes |
|---|---|---|---|---|---|
| Q1 | Contracts: schema and fixture tests, OpenAPI snapshot, monorepo `contracts/fixtures` tests | contracts | vitest | pass | 95 tests (`packages/contracts`) |
| Q2 | Server: unit tests with fake sidecar, HTTP integration tests, SSE lifecycle, auth/CSRF/cookie/proxy, state-file and crypto compatibility fixtures, git runner, terminal, update, Docker invariants | server | vitest | pass | 340+ tests across 26 files; `src/test/continuity.test.ts` boots the server on a state directory written by the Python backend at db3f02679 (`src/test/fixtures/python-state`: sessions incl. a pending-stream session and a `.json.bak` shrink backup, drafts, shares, settings with the update channel, `.sessions.json` with an OIDC-bound record, passkeys, relay config and key, extension overrides, projects, workspaces) and proves: the Python cookie logs in, onboarding stays completed, `/api/sessions`, `/api/session`, `/api/settings`, `/api/projects`, `/api/workspaces` match the recorded Python responses field for field, reads rewrite nothing, and a no-op save reproduces the Python bytes (documented deviations: the draft sidecar overlay both backends persist, `updated_at`/`manual_title` on rename, and `1.0` vs `1` float formatting in `settings.json`). Docker invariants stay under `scripts/check-docker.py` (daemon required) |
| Q3 | Sidecar pytest per RPC method | sidecar | pytest | pass | `sidecar/tests` (runtime handshake, every namespace against recorded fixtures) on the pinned Agent; CI provisions it through `scripts/check-agent-compatibility.py` |
| Q4 | Frontend Vitest and Playwright | frontend | vitest, pw | pass | 187 Vitest; 32 Playwright specs on the Node server (real sidecar or the fixture replay sidecar) |
| Q5 | Regression-port rule: every `test_issue*.py` and `test_regressions.py` case ported by name or listed as dropped with reason | all | ci | pass | `docs/architecture/regression-port-ledger.md`: 390 files / 3174 cases classified; 1957 ported by subject to the named Vitest suites, 1217 dropped with the decided-removal or dropped-route reason, 0 unaccounted. The PR body repeats the counts and the dropped reasons |

## 16. Documentation

| ID | Document set | Status | Notes |
|---|---|---|---|
| G1 | `web/` READMEs, `ARCHITECTURE.md`, `TESTING.md`, `CONTRIBUTING.md`, `AGENTS.md` | pass | checkpoint 9c: README, ARCHITECTURE, and TESTING rewritten for the npm launcher, contract package, server, sidecar, and gates; CONTRIBUTING and AGENTS updated |
| G2 | `docs/*.md` operational guides (troubleshooting, supervisor, onboarding checklist, docker, updates, WSL, chat setup, remote access, extensions) | pass | checkpoint 9c: `talaria-web` replaces `start.sh`/`bootstrap.py`/`ctl.sh`; supervisor units and the PID tree describe the serve supervisor; troubleshooting documents `sidecar_unavailable`; WSL launcher and doc use the bin (native Windows dropped); docker/updates describe the sidecar venv and npm distribution |
| G3 | Architecture and RFC documents (agent API contract, source boundary, frontend migration, SSE and run-adapter RFCs, lock ownership) | pass | checkpoint 9c: agent API contract and source-boundary RFC describe the sidecar boundary; frontend migration/parity docs name the TS server; `sse-streams.md` names `gateway-watcher.ts` and the dropped standalone gateway stream; `lock-ownership.md` rewritten for the event-loop model |
| G4 | Root `README.md`, `CONTRACT_TESTS.md`, `docs/monorepo-migration.md`, changelog fragment | pass | root README, `CONTRACT_TESTS.md`, `docs/monorepo-migration.md` (upstream import section retired), the contract skill, and `changelog.d/TAL-245.json` (rewrite, npm install, contract, self-update, and every dropped feature) |

## 17. Consumers to keep green

| ID | Consumer | Verification | Status | Notes |
|---|---|---|---|---|
| K1 | iOS app (`app/scripts/validate-upstream-contract`, `scripts/check-previous-app.py`) | ci | pass | checkpoint 9c: `app/scripts/validate-upstream-contract` boots the Node server on the replay sidecar; `scripts/check-previous-app.py` and `scripts/check-release-contracts.py` updated |
| K2 | MCP bin (login, rename, move) | vitest | pass | checkpoint 7g (`mcp/server.ts`, bin `talaria-web-mcp`): the seven `mcp_server.py` tools on `@modelcontextprotocol/sdk` over stdio, every read and mutation through the HTTP API (`/api/projects*`, `/api/sessions/search`, `/api/session/rename|move`), password login reused for 25 days, `--profile` as the profile cookie; `delete_project` unassigns only when authenticated, like Python |
| K3 | Extension SDK v1 and sidecar proxy sample | vitest, pw | pass | frontend Vitest (`extensions/host.test.ts`) and the Playwright extension smoke on the Node server |
| K4 | Relay publisher contract fixture | vitest | pass | `packages/contracts` tests sign and verify `contracts/fixtures/publisher-snapshot.json`; `sessions/relay.test.ts` covers the publisher |
| K5 | `contracts/versions.json` and `contract_versions.json` parity | ci | pass | `release.test.ts` asserts `web/contract_versions.json` matches `contracts/versions.json` |
