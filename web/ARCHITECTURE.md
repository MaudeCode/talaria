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
| Sidecar | `sidecar/client.ts`, `discover.ts`, `fake.ts` | newline-delimited JSON-RPC 2.0 over stdio with streamed frames and cancellation; restart with backoff; Agent discovery; the Vitest fake |
| CLI | `cli/launcher.ts`, `ctl.ts`, `dotenv.ts`, `supervise.ts`, `bin/*` | `talaria-web` bootstrap, `ctl`, `.env` precedence, the serve supervisor, `talaria-web-mcp` |

Media byte responses keep the anchored descriptor and hard-link checks on every
request. Buffered reads yield through asynchronous descriptor IO. A range reads
only its selected span unless an uncached conditional request needs a content
validator. The server retains at most 256 validators, keyed by device, inode,
size, and nanosecond modification/change timestamps, and never caches media
bytes or open descriptors. Uncached ranges may omit an ETag. Buffered reads
recheck the descriptor signature before publishing a validator; streamed bodies
own their descriptors through completion or cancellation.

A sidebar cache miss sends its interactive and background windows in one worker
request. The windows share a read-only SQLite snapshot, schema probes, validated
local lineages and one ownership lookup over their combined candidates. Storage
health comes from the same handle. If shared ownership metadata is damaged, the
reader retries ownership per window within that snapshot so healthy windows remain
available. Sidebar and targeted metadata results share
the five-second cache, scoped by profile, source filter, sorted session IDs and
lookup flags, and invalidated by database/WAL stamps or the session-index revision.
The cache retains at most 200 snapshots.

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

Web runtime persistence is selected by `TALARIA_STORAGE`, defaulting to `json`. Unknown values fail startup.
`SessionStore` owns resident sessions, mutation locks, write serialization and index projection. Only its
backend adapter accesses session files. Reads carry opaque revisions; stale writes raise
`RevisionConflict`, reload the cache and preserve the committed document. Message changes are typed
as unchanged, append, splice or replace. Full document reads return their parsed messages so a full cache miss
reads and parses the file once. The store keeps those rows separate from the mutable session and
computes their diff fingerprints on the first save. Content search sends one batch of unmatched candidates through
the backend, with cached full transcripts handled by the store. Shared extraction and matching functions
in `sessions/storage/search-text.ts` define search semantics for every adapter.

An adapter implements `StorageBackend`, passes `runSessionBackendConformance`, `runDocumentBackendConformance` and `runJournalBackendConformance`, and owns its recovery
checks through `diagnose`/`repair`. Cross-backend recovery still reconciles the read-only Agent database.
The JSON adapter keeps existing paths, bytes, permissions and atomic publication behavior. Its persisted-session
ID cache checks the session directory revision on every read and returns an independent set. Owned writes and
deletes invalidate it before mutation so concurrent external changes cannot be stamped over. External directory
changes also invalidate it. Session listing reuses one index read
when the index is healthy and retains its rebuild/full-scan recovery paths. Auth table writes
stage and fsync asynchronously, then compare the expected revision and publish without an intervening await.
Shutdown drains queued writes and closes journal writers before storage closes.

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
fall back to discovery and misses are never cached. Session deletion and backend close release cached owners.
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

After automatic compression, `chat.start` returns capped model context separately from the full visible
transcript. The cap preserves paired skill loads' reload markers and failure verdicts even after the raw-output
budget is exhausted. Skill bodies still spend that budget; inline slash-skill user messages remain intact.

Canonical Agent sessions have one additional observation path: `gateway.session` in the existing
sidecar gateway namespace discovers an already running owner, obtains a profile-bound one-use ticket,
negotiates capabilities, and exposes typed session operations. `sessions/gateway-sessions.ts` projects
its snapshots and events through the existing foreign-history, pending-prompt, chat-stream, and queue
components. It never materializes a writable Talaria session or settles the owner's transcript locally.
The Agent owns admission, execution, recovery, and revision/generation-fenced mutations. Talaria's
observational journals and stream scope include the complete profile home and session identity.
Watches negotiate the profile's Web reasoning display preference with the owner and map reasoning, subagent lifecycle and usage events into the existing chat frames. Unsupported display negotiation leaves older owners observable.
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

## 5. Frontend

`packages/frontend` keeps the TanStack Start structure documented in
`docs/architecture/frontend-migration.md`: routes, features, the contract client (`src/api/orpc.ts`,
`client.ts` with CSRF, GET coalescing, 401 redirect, timeouts), SSE consumers on the contract event unions,
the sandboxed extension platform (`docs/architecture/extension-protocol-v1.md`), i18n, service worker, and
the in-memory contract server used by Vitest (`src/adapters/memory.ts`). `npm run build:fast` produces
`static/dist/`, which is not committed: CI builds it for tests, the npm package and the container image.

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
