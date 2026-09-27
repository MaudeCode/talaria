# State ownership and serialization

The TypeScript server runs on one event loop. There are no threads and no
process-wide mutexes; serialization is expressed as promise chains, single-flight
caches, and coalescing queues. This document names the owner of each piece of
mutable state and the rule that keeps its on-disk transaction atomic, so a
change that adds an `await` inside one of these sections knows what it is
holding open.

Three rules apply everywhere:

1. **A file transaction never yields between read and write.** Read-modify-write
   sequences on JSON state run synchronously (`readFileSync`, mutate, atomic
   `writeFileSync` + `rename`), so no other request can interleave. Where a
   subprocess or network call belongs inside the transaction (git, the sidecar,
   the relay), the owner below holds a promise-based lock instead.
2. **Cross-process coordination uses the same files the Python backend used**:
   `.tmp.<pid>` atomic writes, `.bak` shrink guards, the per-profile
   `.session_cleanup.lock`, per-journal shard files, and `flock`-style turn
   journal shards keyed by pid liveness.
3. **A failed local write returns or logs an explicit degraded result** and
   never falls back to another profile's state. Auth session persistence stays the
   documented availability exception: a failed `.sessions.json` replace is logged
   and the signed session remains valid in memory until restart.

| State owner | Serialization | I/O kept inside and why |
|---|---|---|
| Agent configuration (`config.yaml`, `.env`) | `AgentConfig` read cache keyed on mtime/size; writes are synchronous atomic replaces that preserve mode/uid/gid | A stale snapshot is never published as a write baseline. |
| Settings (`settings.json`) | `SettingsStore` synchronous load/save with the allowlist and migrations | Defaults, migration, and the atomic write happen in one call. |
| Sessions (`sessions/<sid>.json`) | Per-session promise lock in `SessionStore`; the LRU evicts only clean persisted sessions | Mutation and `save()` run under the session lock; the coalesced index writer receives an immutable row snapshot. |
| Session index (`_index.json`) | Coalescing writer: concurrent saves publish rows into one pending batch, one rewrite per batch | A rewrite that throws rejects every saver in its batch; the next batch still runs. |
| Tombstones (orphans, deleted sessions) | Synchronous read-modify-atomic-write per mutation | Bounded files; no await inside. |
| Drafts (`sessions/_drafts`) | Monotonic `_draft_version` compare-and-write per session | Stale versions are rejected, not merged. |
| Run and turn journals | Per-journal append queue; retention in the hygiene ticker | Append order per `(session, stream)` is preserved; shard release follows pid liveness. |
| Chat runs | `StreamRegistry` (`STREAMS`/`ACTIVE_RUNS` equivalent) plus per-session serialization in `TurnRunner` | One active turn per session; cancel and steer resolve through the registry, never through the sidecar alone. |
| Pending approvals and clarify questions | `PendingPrompts` queues per session | Submit/resolve are synchronous; SSE fan-out happens after the queue mutation. |
| Auth sessions, login attempts | In-memory tables are authoritative; one write-behind writer per file (one write in flight, later requests coalesce into a single follow-up of the newest table); orderly shutdown and restart await `flushPersistence()` | Rate-limit decisions read and update the table in one synchronous call; a slow fsync never blocks a request. |
| Passkey challenges | Synchronous read-modify-atomic-write per mutation | Bounded file; no await inside. |
| Shares, extension state, sidecar tokens, media snapshots | Synchronous read-modify-atomic-write per mutation | Token minting happens before the manifest commit. |
| Provider caches (catalog, quotas, cost snapshots, OAuth flows) | Single-flight promises keyed on identity; cost snapshots use the per-provider lock file | A cold catalog build is shared by concurrent readers. |
| Profiles | Process-global active profile; profile list cache with TTL; per-profile skills-stats cache | A switch clears dependent caches before publishing the new profile. |
| Workspace git | Per-repository promise lock in `GitRunner`; status cache guards only the in-memory payload | Checkout, stage, commit, fetch, pull, push hold the repository lock across the subprocess. |
| Relay pairing and publisher | `RelayService.pair` serialized; `RelayPublisher` coalescing loop | Registration and publisher swap complete before the next pairing starts. |
| Gateway restart | Sidecar `gateway.restart` single-flight (the sidecar holds the lock) | Discovery, launch, and wait happen in the sidecar. |
| Self-update | `UpdateService` apply lock; restart waits for active runs and streams (bounded at 300 s) | Fetch, status, fast-forward, and stamping run under the lock; the restart is an exit code handled by the supervisor. |
| Terminals | `TerminalRegistry` (32 cap, idle reaper) | Backlog and resize are per-terminal; close-all runs at shutdown. |
| Sidecar | One `SidecarClient`; pending map keyed by request id; restart backoff | Calls made while restarting reject with `sidecar_unavailable`; streams for dead requests are dropped. |

Extension uninstall remains best-effort at the asset layer: per-file removal
errors are ignored and the manifest entry is still removed, so a successful
response can leave untracked extension files on disk; reinstall or
administrator cleanup is the recovery path.
