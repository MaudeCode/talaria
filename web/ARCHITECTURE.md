# Talaria Web architecture

Talaria Web is a TypeScript server on Node 24 plus a React frontend. Everything that needs Hermes Agent
Python code runs in one Web-owned sidecar process. This document describes the shipped layout; the
subsystem contracts it references live in [docs/CONTRACTS.md](docs/CONTRACTS.md).

## 1. Components

```
web/
  package.json                 npm workspaces root: build, test, typecheck, lint, e2e, openapi
  packages/contracts/          @maudecode/talaria-web-contracts — oRPC contract, Zod schemas, SSE unions,
                               sidecar RPC schema and fixtures, OpenAPI generator
  packages/server/             @maudecode/talaria-web — HTTP server, oRPC handlers, SSE, state, sidecar
                               client, bootstrap/ctl/update CLIs, MCP bin
  packages/frontend/           TanStack Start / React SPA consuming the contract client
  sidecar/                     talaria_sidecar (stdlib Python) + its pytest suite; agent_dependency.json pins the Agent
  static/dist/                 frontend build served by the server (built, not committed)
  Dockerfile, docker-compose*.yml, docker_init.bash   node:24-slim image; Python only for the Agent venv
```

### Coupling chain

```
Hermes Agent  <-(sidecar/agent_dependency.json)-  sidecar
                                                  <-(SIDECAR_RPC_VERSION in contracts)-  server
                                                     <-(contracts/web-api.openapi.json + contracts/versions.json)-  iOS app
```

One pin per arrow. The sidecar verifies the loaded Agent revision against its pin and reports
`{agent_revision, pinned_revision, compatible, stale}` at handshake; the server trusts that handshake and
surfaces `agent_runtime_stale` / `agent_incompatible` as `503` conditions. The server never reads the pin.

## 2. Contract package

`packages/contracts` (`docs/architecture/contract-package.md`) defines:

- every HTTP route (method, path, tags, input, output) with `@orpc/contract`; response shapes are pinned
  in `src/views.ts` (known fields typed, documented passthrough for opaque Agent data);
- SSE event unions per stream in `src/sse.ts` (chat, session list, approval, clarify, terminal, kanban);
- the sidecar RPC (`src/sidecar/*`): method params, results, streamed frames, and `SIDECAR_RPC_VERSION`;
- the `RAW_ROUTES` manifest for the handful of non-oRPC routes (SSE, downloads, uploads, OIDC redirects).

`npm run openapi` regenerates `../contracts/web-api.openapi.json`; CI fails when the committed document
differs. The frontend imports the typed client (`@orpc/client` + `@orpc/openapi-client`) and has no
hand-written endpoint schemas.

## 3. Server

`packages/server/src`:

| Area | Modules | Notes |
|---|---|---|
| Pipeline | `app.ts`, `server.ts`, `http/*`, `auth/*` | profile cookie → `Origin: null` rejection → auth (public / operator-only paths, profile mismatch 403) → startup gate (503 `startup_recovery`) → handler; CSRF (same-origin + HMAC token, non-browser bypass), security headers and CSP, trusted proxies, TLS, worker budget and per-client stream cap, 20 MiB body cap, multipart |
| Routes | `api/router.ts`, `api/*-router.ts`, `api/*-raw.ts`, `api/sse-routes.ts` | oRPC handlers per contract namespace plus raw routes; `HttpError(status, message, extra)` envelopes |
| Sessions | `sessions/store.ts`, `sessions/storage/`, `session.ts`, `list.ts`, `drafts.ts`, `shares.ts`, `journal.ts`, `titles.ts`, `export.ts` | Async `StorageBackend` ports for sessions, revisioned documents and run journals; the JSON adapter preserves the existing files and bytes. Domain stores retain validation and policy, with persistence behind these ports. |
| Chat | `sessions/turn.ts`, `streams.ts`, `pending.ts`, `channels.ts`, `events.ts` | stream registry, SSE replay from journals, approvals/clarify/goals over the sidecar, cancel/steer, compression, titles, metering |
| Agent sessions | `sessions/state-db.ts`, `state-db-worker.ts`, `cli-sessions.ts`, `gateway-watcher.ts`, `completions.ts` | read-only `state.db` projection through `node:sqlite`; the session list, gateway watcher, relay, and single-session lookups (request routing, owner locks, chat start, detail, and mutation gates), and the transcript reads (turn history, turn settlement, session detail, and transcript edits) read it on two long-lived `worker_threads` workers so a slow database never blocks the event loop or queues session reads behind sidebar work; gateway watcher per profile home; background completion drain and wake-up turns |
| Workspace | `workspace/*` | hardened git runner, worktrees, rollback checkpoints, uploads, media, zip |
| Tools | `tools/*` | skills, memory, prompts, crons, kanban, extensions + sidecar proxy, MCP health, terminal (`node-pty`), insights, system health, self-update (`tools/updates.ts`), log hygiene |
| Providers | `providers/*` | model catalogs, quotas, OAuth device flows, TTS |
| Profiles | `profiles/*`, `settings.ts`, `onboarding.ts` | profile homes, `config.yaml` and `.env` writes, settings defaults and migrations |
| Relay | `sessions/relay.ts` | Talaria Relay pairing, presence leases, Ed25519-signed publisher |
| Notifications | `sessions/notify/` | Shared activity rows (`activity.ts`), the channel port and hub (`channel.ts`), the alert rule shared with the relay (`alerts.ts`, pinned by `contracts/fixtures/notification-alerts.json`), and browser Web Push (`web-push.ts`; `TALARIA_WEB_PUSH_SUBJECT` overrides the VAPID subject) |
| Sidecar | `sidecar/client.ts`, `discover.ts`, `fake.ts` | newline-delimited JSON-RPC 2.0 over stdio with streamed frames and cancellation; restart with backoff; Agent discovery; the Vitest fake |
| CLI | `cli/launcher.ts`, `ctl.ts`, `dotenv.ts`, `supervise.ts`, `bin/*` | `talaria-web` bootstrap, `ctl`, `.env` precedence, the serve supervisor, `talaria-web-mcp` |

JSON responses use compact serialization by default. Raw handlers can request
pretty output explicitly. Raw and oRPC JSON responses share asynchronous gzip
compression at level 6 when the serialized body exceeds 1 KiB and the client
accepts gzip, leaving the event loop available for live-stream heartbeats.

Media byte responses keep the anchored descriptor and hard-link checks on every
request. Buffered reads yield through asynchronous descriptor IO. A range reads
only its selected span unless an uncached conditional request needs a content
validator. The server retains at most 256 validators, keyed by device, inode,
size, and nanosecond modification/change timestamps, and never caches media
bytes or open descriptors. Uncached ranges may omit an ETag. Buffered reads
recheck the descriptor signature before publishing a validator; streamed bodies
own their descriptors through completion or cancellation.

Workspace editor saves stage a complete replacement in an exclusively created sibling file,
carry over the destination's permission mode, sync it, then atomically rename it over the original.
The anchored directory walk owns staging, replacement and failure cleanup in one descriptor-relative
operation, using the verified cwd fallback on macOS. A failed write, sync or replacement leaves the
original bytes intact. Symlinks and non-regular targets remain refused.

A sidebar cache miss sends its interactive and background windows in one worker
request. The windows share a read-only SQLite snapshot, schema probes, validated
local lineages and one ownership lookup over their combined candidates. Storage
health comes from the same handle. If shared ownership metadata is damaged, the
reader retries ownership per window within that snapshot so healthy windows remain
available. Sidebar and targeted metadata results share
the five-second cache, scoped by profile, source filter, sorted session IDs and
lookup flags, and invalidated by database/WAL stamps or the session-index revision.
The cache retains at most 200 snapshots. Database/WAL signatures sampled within
two seconds of their modification timestamp cannot prove unchanged content on a
coarse-timestamp filesystem. Both the row cache and gateway watcher bypass reuse
for those samples, including future timestamps. The watcher acknowledges a fresh
projection after the files settle, then resumes its unchanged-file fast path.

The model picker shares one pool-limit read per profile and catalog source. Its
sidecar deadline is three seconds; successes and failures are cached for 45 seconds.
A warm cache answers immediately during refresh, and expired cooldowns are omitted
on every response. Catalog invalidation or changed credentials discard that snapshot.

The `state.db` dispatcher keeps two independent FIFO lanes. The listing lane handles
rows and row batches, fingerprints, storage health and Web diagnostic IDs. The session
lane handles interactive `SESSION_READS`, source ownership and existence probes.
Sidebar row enrichment and owner/orphan lookups carry an async listing context, so
their nested source, existence and cron-admission reads stay on the listing lane
without changing concurrent interactive or mutation-gate reads. A lane crash
rejects only its pending reads; shutdown stops both lanes and prevents restarts until
both exit. Each worker retains its own read-only handle per database path and file identity.
Each read gets a fresh transaction and checks its schema version before reusing column
and index probes. Every reader commits its snapshot in `finally`; shutdown and file
replacement release the cached handles. Main-file modifications also reopen the handle
so in-place damage cannot hide behind cached pages; ordinary WAL commits reuse it.
File-operation existence checks, cron completion links, insights, fork-parent probes,
handoff reads and lineage reports use the same worker dispatcher. Fork-parent checks
probe one active message instead of loading a transcript. Cron completion results are
read from a bounded recent window, streaming older rows only when requested jobs remain.
Insights union the Agent's indexed effective-activity window with sessions that started,
ended or received messages within the window, then check exact freshness. A stale
heartbeat never drops recent activity; older schemas retain the full message-activity
fallback. Without a global message-time index, the recent-message candidates require
one covering-index scan; schemas without the session/message index aggregate messages
once for both candidate selection and freshness. Handoff round counts inspect physical
role/timestamp rows, while summaries read the stitched active transcript once; those distinct projections
stay on the worker without changing their compaction semantics.
Recovery keeps its own short-lived handle.
Each thread retains at most 16 handles, closing the least recently used path on
eviction so deleted profiles cannot accumulate unbounded descriptors or page caches.

The listing's orphan prune removes only Web-owned cached sidecars: read-only CLI, API-server
and Desktop imports of the active profile whose row that profile's `state.db` proves absent.
One batched existence probe per list serves the prune, and delete uses the same eligibility.
A missing or unreadable `state.db`, another profile's row, a held run or a canonical owner keeps
the sidecar; Agent records are never deleted.

Worktree lifecycle status probes use private Git metadata and copied indexes. Only non-executable
status settings enter that view; live repository filter definitions and configuration includes cannot
be loaded by its status command. Initialized submodules use the same boundary, preserving their
ignore settings. Copied index timestamps never advance, preserving Git's racy-stat content checks.
A single deadline covers metadata preparation and the recursive probe.
Normal removal preserves Git's final non-forced clean check at the original path. That internal status
inherits a private common-directory configuration and a snapshot index guarded by the original
`index.lock`. Late file or open-descriptor writes are checked by Git before deletion. Gitlinks,
including uninitialized submodules, require explicit force because they could become populated during
that internal check; `force_required` reports this policy. Explicitly forced removal retains its existing
semantics. An interrupted normal removal can leave an index lock; verify that no remover or Git writer is still running before removing
that stale lock.

State ownership: WebUI-owned files (sessions, settings, auth records, journals, shares, drafts, relay
config, extension state) are written only by the server. Agent-owned files (`config.yaml`, `.env`, profiles,
skills, memories) are read and written as file formats by the server; `state.db` writes and the
`delete_cli_session` transaction go through the sidecar.

Turn `state_saved` notices compare asynchronous memory and skill signatures before and after execution.
The server retains at most 32 profile skill inventories, reusing discovered paths while every visited
directory's identity and timestamps match. File signatures are refreshed each time so in-place skill
edits remain visible; changed directories trigger one pruned walk, and incomplete walks are not cached.

Deleted-session relay acknowledgements live in `talaria-relay-deleted.json` under the Web state directory.
`RelayService` stages the session, canonical originating profile, identity and completion cutoff before
the session file is removed, including while the publisher is unavailable. A failed outbox write leaves
the session available for retry. A staged entry waits while session data still exists, including after
a failed removal or restart; a later deletion attempt advances its cutoff to cover the final deletion.
`RelayPublisher` replays this outbox at startup and replacement through the existing signed viewed route
after publishing snapshots.
An entry binds once to its relay origin, publisher and profile ID, and stays pending through failures,
disabled or unavailable profiles, and shutdown until a successful response. Replays keep the cutoff and
use fresh signing nonces. Reads and acknowledgement removals reload the file synchronously, so an
in-flight response cannot erase newly queued deletions. Invalid outbox state fails without overwriting
it. The separate started ledger retains its announcement semantics. This additive file is ignored by
older Stable versions and remains available when returning to a version that supports replay.

Web runtime persistence is selected by `TALARIA_STORAGE`: `json` (the default) or `sqlite`. Unknown values fail startup.
The SQLite adapter (`sessions/storage/sqlite*.ts`) uses one `node:sqlite` connection to `<stateDir>/talaria.db` in WAL
mode, with numbered schema migrations; a database from a newer schema refuses to open. Messages are rows keyed by
`(session_id, idx)`, so range reads, appends and tail splices touch only their rows. An FTS5 trigram index over each
message's JavaScript-lowercased search text narrows content search to one statement; the shared matcher still decides
every result. `talaria-web storage copy` moves an install between backends through the `StorageBackend` port and
verifies the copy, so a new adapter gets migration for free.
`SessionStore` owns resident sessions, mutation locks, write serialization and index projection. Only its
backend adapter accesses session files. Reads carry opaque revisions; stale writes raise
`RevisionConflict`, reload the cache and preserve the committed document. Message changes are typed
as unchanged, append, splice or replace. Full document reads return their parsed messages so a full cache miss
reads and parses the file once. The store keeps those rows separate from the mutable session and
computes their diff fingerprints on the first save. Content search sends one batch of unmatched candidates through
the backend, with cached full transcripts handled by the store. Shared extraction and matching functions
in `sessions/storage/search-text.ts` define search semantics for every adapter.

Chat attachments go through a separate `BlobStore` port (`sessions/storage/blobs.ts`), selected by
`TALARIA_BLOB_STORAGE` independently of `TALARIA_STORAGE`. Keys are `attachments/<sanitized sid>/<name>`. The
default `local` adapter is the attachment directory (`<stateDir>/attachments` or `HERMES_WEBUI_ATTACHMENT_DIR`)
with its anchored exclusive creates; its etag is the inode/size/change-time signature upload receipts always
compared. The `s3` adapter (`blobs-s3.ts`) stores objects in an S3-compatible bucket and materializes each one
under `<stateDir>/blob-cache/attachments/...` through `localPath`: concurrent calls share one download, the bytes
are checked against the etag, and a least-recently-used cap (`TALARIA_BLOB_CACHE_MAX_MB`) bounds the cache, which
starts empty each run. Upload paths are those local paths in both modes, so the turn, `/api/file/raw`,
`/api/media` and share snapshots keep their path-based anchored reads; each materializes the file first. Archive
extraction writes into the local directory and `commitLocal` stores each file. Session delete removes the session
prefix. An unknown kind or an unreachable bucket fails startup. `talaria-web storage copy-blobs` copies between
stores with the server stopped, verifying size and SHA-256 and skipping objects already present. Every adapter
passes `runBlobStoreConformance`.

An adapter implements `StorageBackend`, passes `runSessionBackendConformance`, `runDocumentBackendConformance` and `runJournalBackendConformance`, and owns its recovery
checks through `diagnose`/`repair`. Cross-backend recovery still reconciles the read-only Agent database.
The JSON adapter keeps existing paths, bytes, permissions and atomic publication behavior. Its persisted-session
ID cache checks the session directory revision on every read and returns an independent set. Owned writes and
deletes invalidate it before mutation so concurrent external changes cannot be stamped over. External directory
changes also invalidate it. Session listing reuses one index read
when the index is healthy and retains its rebuild/full-scan recovery paths. Auth table and session
document writes stage and fsync asynchronously, then compare the expected revision and publish without an intervening
await; session index writes stage the same way.
Shutdown drains queued writes and closes journal writers before storage closes.

JSON documents retain at most 256 recently used byte/revision/parse snapshots per backend. Reads check
device, inode, size and nanosecond modification/change timestamps, sharing the config cache's fingerprint
helper. Unchanged files need one stat; returned objects are cloned. Successful writes seed their published
bytes without rereading, using a descriptor held across publication so a competing replacement cannot lend
its identity to old bytes. In-place edits during publication invalidate the seeded snapshot. Auth publication
seeds before yielding, and deletion or shutdown releases snapshots.

`documents` owns drafts, shares, held wakeups, projects, settings, auth keys/tables, passkeys/challenges,
notifications, deletion records, extension state, background receipts, workspace registries and last-workspace
pointers, relay configuration/generated keys/profile identities/ledgers/outboxes, quota scope identity, and the
recovery marker. Its shared edit helper serializes edits per backend/document and retries one revision conflict.
Bounded reads preserve the extension-state byte limits. Read/modify/write policy stays with the domain store.
Profile names scope workspace and relay identity keys; only the JSON adapter resolves their historical paths.
Deletion clears those documents after the Agent removes the home, with the durable deletion record retained
through cleanup failures. Recreation retries cleanup before clearing that record. Identity writes never create
an Agent-owned profile directory.
Operator-supplied key files, Agent-owned formats, workspace contents, attachments, logs/PIDs and installation
rollback artifacts remain filesystem resources.

`journals` owns run append/replay, bounded tails, summaries, retention and legacy turn-journal recovery reads.
It protects active writers during pruning. Sidecar frames are processed in order and published after append;
arrival timestamps remain authoritative for event times, tool durations and metering even when storage is slow.
The JSON journal keeps at most 1,000 recently used run-to-session resolutions per backend instance.
Each lookup rechecks the resolved journal or pruned summary and reads its current contents; missing paths
fall back to discovery and misses are never cached. A run writer records its owner when it opens, so a run started
by this server never needs discovery. Session deletion and backend close release cached owners. SSE and chat
stream handlers resolve a stream's owner and journal summary once per request (or per gap recovery) and pass it on.
Per-session SSE reconnects read each journal asynchronously once. The replay result owns a request-local
continuation that reads only the active run's appended bytes before handing off to the live queue.
The continuation shares the replay's byte/row limits and checks file identity and contiguous sequence;
an unsafe tail or a newly created non-active journal falls back to a session snapshot.
No journal offsets persist across requests.

Concurrency: one event loop, no locks. Per-session serialization, stream slots, the coalesced index
writer, and the update lock are promise-based; `docs/lock-ownership.md` lists the ordering rules that
survived the move from threads.

Self-update (`tools/updates.ts`): a recognized clean checkout fast-forwards to the newest completed
release set (stable) or `origin/main` (experimental), stamps `_release.json` from immutable git blobs,
and restarts once active work drains by exiting with code 75 so the `talaria-web serve` supervisor
respawns the worker with the same PID tree that ctl, launchd, and systemd track. npm and container installs
report `manual_update`.

Windowed session details use a revision-owned `SessionPrefixIndex` on the resident session. It records absolute
turn coordinates, tool-result dependencies, provenance and transcript summaries. Page derivation widens only to the
required turns. A validated seen marker permits a keyset read of the Agent tail; legacy markers and ambiguous
unidentified copies retain the full-reader fallback. The tail summary and ownership/routing lookups are cached against
session, database and WAL revisions, so unchanged older pages do not open SQLite. Saving verifies indexed rows during
serialization before extending an appended prefix; rewritten rows invalidate it. Requests without `msg_limit` retain
the full projection. No index is written to the Agent database or the session document.

Agent `state.db` reads use three lazy workers with separate FIFOs and read-only handle caches.
Sidebar batches and their nested enrichment probes stay on the listing lane. Source/ownership,
existence, local-target and raw-row probes use the authority lane; transcript and settlement reads
use the session lane. Admission subagent classification and fresh-chat wire projection share the
authority source reader, including receipt and compression ownership fences. A slow history or
sidebar read cannot queue ahead of those checks. An intrinsically blocked authority query can still
wait on SQLite or the filesystem; failed authority remains read-only.
The dispatcher adds aggregate `state_db_reads` to chat startup timing, keyed only by lane and
operation, with `count`, `queue_wait_ms` and `execution_ms`. Queue wait includes worker startup
and delivery; execution includes the query and filesystem work. Both use the process monotonic
clock across worker threads. No database paths, session ids or transcript payloads enter these fields.
All lanes terminate on shutdown and reject their pending calls before a later request can restart them.

Cron completion links and imported session titles share the read-only identity reader in
`sessions/state-db.ts`, dispatched on that worker. Gateway-fired runs resolve through the
scheduler principal's `cron:<job>:<execution>` admission; legacy timestamp ids resolve their
exact job, including underscores. Completion links only consider terminal admissions, while
active admissions still name their sessions. Stores without admissions retain legacy behavior.
This only enriches display metadata and never changes Agent ownership or writes to `state.db`.

## 4. Sidecar

`sidecar/talaria_sidecar` (`docs/architecture/sidecar-rpc.md`) is spawned as
`<agent venv python> -m talaria_sidecar` with `PYTHONPATH` pointing at the sidecar package and the Agent
appended to `sys.path`. Namespaces: `runtime`, `chat` (AIAgent turns with streamed callbacks, interrupt,
steer), `approval`, `goals`, `profiles`, `cron`, `kanban`, `skills`, `commands`, `plugins`, `providers`,
`models`, `aux` (auxiliary LLM calls), `text` (image input routing, portal tags), `stt`, `mcp`, `process`
(background completions), `state_db`, `gateway`, `worktree`, `config`. Each method has a Zod schema in
the contract package and a recorded fixture under `packages/contracts/fixtures/sidecar/` used by both
the pytest suite and the Vitest fake. `sidecar/scripts/replay_sidecar.py` replays those fixtures and stages
one approval so browser e2e and the iOS contract runner need no Agent.

The worker starts the sidecar handshake concurrently with server initialization and opens HTTP before
waiting for that handshake. Public pages and authentication remain available during Agent imports.
Config reads validate the live RPC version through import-free `runtime.status` before reading
operator authentication settings. This does not promote Agent readiness or permit config writes during startup.
Chat admission answers `503 sidecar_unavailable` while the sidecar is starting or reconnecting, without
queuing a runtime check behind the handshake. Handshake metadata is read lazily from the sidecar.
Source-checkout dirty fingerprints compare actual Web content without refreshing the Git index,
excluding timestamp-only rewrites and unrelated monorepo components from the startup scan.

`chat.start` reads one profile config snapshot for toolsets and Agent construction. Helpers reuse
that snapshot for fallback routes, prefill, request options, provider routing and checkpoints.
Mutable options retained by the Agent are copied so it cannot modify the shared read-only config.
Standalone helper callers still load their own config.

After automatic compression, `chat.start` returns capped model context separately from the full visible
transcript. The cap preserves paired skill loads' reload markers and failure verdicts even after the raw-output
budget is exhausted. Skill bodies still spend that budget; inline slash-skill user messages remain intact.
Only the Agent's native `ContextCompressor` (including subclasses), or no engine, gets this pruning and cap; the
active engine object decides, not its configured name. An external context engine's tool bodies and reference markers
pass through unchanged, and the request estimate describes the context actually returned.

Canonical Agent sessions have one additional observation path: `gateway.session` in the existing
sidecar gateway namespace discovers an already running owner, obtains a profile-bound one-use ticket,
negotiates capabilities, and exposes typed session operations. `sessions/gateway-sessions.ts` projects
its snapshots and events through the existing foreign-history, pending-prompt, chat-stream, and queue
components. It never materializes a writable Talaria session or settles the owner's transcript locally.
The Agent owns admission, execution, recovery, and revision/generation-fenced mutations. Talaria's
observational journals and stream scope include the complete profile home and session identity.
Watches request reasoning from the owner so Show can resume it on an existing observation. The server applies the current profile display preference to reasoning and subagent-thinking frames, and maps subagent lifecycle and usage events into the existing chat frames. Unsupported display negotiation leaves older owners observable.

The same profile-bound observation owns native todo state. Optional owner snapshots and
`todo.updated` events feed `sessions/todo.ts`, the direct-chat normalizer, which ships
display text, states and counts in `session.todo_state` and the existing `todo_state` SSE.
Owner null and empty plans clear stale lists; omitted fields use the full transcript fallback.
Execution/owner epochs, todo revisions and replay sequences fence updates. Idle viewers
refresh through `session-updated`; the existing Todos page uses the session query cache
and `useTranscript` observation lifecycle, with no separate task cache or Agent admission.
Direct chats ship the running turn's live list in session detail ahead of the settled one; a
history cut (clear, truncate, retry, undo) that removes the turn behind a kept failed-turn list
ends that list. A live `todo_state` cancels and rereads any detail read already in flight.
Unknown admissions require an explicit recovery decision. On Agents with `clarify.lock` (v0.22.3+), the
owner's native CLI clarify batch reaches the attached watch once, as a `clarify_batch` stream event; the
server shows it as one clarify card, locks each answer, and clears it on the owner's `request.cancel`.
Older Agents keep batch turns locked without answering or cancelling them. Ordinary native secure-input
requests are declined. During a restart's after-turn wait (`restart_wait`), the sidecar still attaches
for snapshots, watches, receipts, approvals, clarify answers and interrupts, refuses other actions with
`gateway_restarting`, and the server ships `owner_attachment.restarting` so clients stop sending. A
watch opened before the wait polls discovery, never its own socket, and emits `restarting` when the wait begins.

Diagnostic fresh chats (`execution_mode` `ignore_config` or `safe` on `POST /api/session/new`) are
minted by the same owner through `gateway.create`, which requests `session.create` with the Agent's
`ignore_user_config` / `safe_mode` creation policy after `runtime.describe` advertises those fields.
The owner freezes the policy in its creation receipt and runs every turn in a fresh private worker;
Talaria never imports the Agent with it, flips a process global or passes it through the environment,
and never falls back to an ordinary chat. The effective `execution_mode` on session rows is read from
that receipt, so it survives reconnects and restarts. Talaria mints these requests as `talaria-web:<id>`;
the sidebar lists receipt-proven Web-created diagnostic chats even when external Agent sessions are hidden.
Owner chats take no attachments, so the mode list carries `can_attach` for the unsaved composer.

Agent-wide `startup-warning.*` notices are persisted as profile-scoped `agent_warning`
notifications rather than session notices. The turn admission captures the notification
owner for background continuations. Repeated keys keep their dismissal/read state until
the full warning text changes; `notice_clear` removes the row and `notices_reset` leaves
it alone. Credit, usage and other per-session notices keep their existing lifecycle.

The shared Agent runtime starts the native Nous connected-app handoff worker when the installed
Agent provides it. It runs without a Nous chat or auth keepalive, including retained work from
other profiles. The Agent owns account proof, locks, backoff and credential cleanup. Sidecar
shutdown, source drift and dependency/source mutation retirement join the worker before releasing
custody; retained work remains resumable by a fresh process. Missing modules on older Agents are
supported and skip worker retirement. Recovery acknowledges a matching ready runtime after reconnect
before starting another repair. A present worker that fails startup makes the Agent import incompatible.
OAuth and connector status reads do not dispatch retries.

## 5. Frontend

`packages/frontend` keeps the TanStack Start structure documented in
`docs/architecture/frontend-migration.md`: routes, features, the contract client (`src/api/orpc.ts`,
`client.ts` with CSRF, GET coalescing, 401 redirect, timeouts), SSE consumers on the contract event unions,
the sandboxed extension platform (`docs/architecture/extension-protocol-v1.md`), i18n, service worker, and
the in-memory contract server used by Vitest (`src/adapters/memory.ts`). `npm run build:fast` produces
`static/dist/`, which is not committed: CI builds it for tests, the npm package and the container image.

i18n: Paraglide compiles one module per message. `src/i18n/localeSplit.ts` keeps only the English function in
each module and builds one lazily imported chunk per other locale (entries identical to English are left out
and fall back to it). `applyLocale` installs the active locale's chunk before switching, so boot and runtime
switches render translated from the first frame; the service worker keeps the active chunk beside the shell.

## 6. Runtime and startup

```
talaria-web            .env → discover Agent → sidecar preflight → detached start (or attached under a supervisor)
  └─ serve             supervisor: spawns the worker, forwards signals, respawns on exit code 75
       └─ worker       loadConfig → launchSidecar (handshake) → createDeps → HTTP listen → workers
                        (relay publisher, completion drain, hygiene ticker, gateway watchers, MCP probes)
```

Readiness: `/health` reports `starting` until session recovery finishes. The Agent pin records the tested
identity; a different importable revision may run with a warning. Agent-backed routes answer `503` with
`condition: sidecar_unavailable | agent_runtime_stale | agent_incompatible` when the sidecar is down, the
loaded checkout changes, or a required capability is missing. Operator config reads and writes can still
work after an Agent import failure so SSO and authorized recovery remain available. Shutdown drains streams
and stops workers on SIGTERM/SIGINT.

## 7. Adding an endpoint

1. Add the route to the contract namespace in `packages/contracts/src/routes/*.ts` with pinned input and
   output schemas (put the response shape in `src/views.ts`).
2. Implement the handler in the matching `packages/server/src/api/*-router.ts`; sidecar-backed work adds
   a method to `packages/contracts/src/sidecar/namespaces.ts`, the Python implementation under
   `sidecar/talaria_sidecar/methods/`, a recorded fixture, and a pytest case.
3. Regenerate OpenAPI (`npm run openapi`) and, if the iOS app consumes it, update its decoders and
   `contracts/versions.json`.
4. Test through `bootTestServer` with the fake sidecar (see [TESTING.md](TESTING.md)).
