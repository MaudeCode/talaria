# Run State Consistency Contract

- **Status:** Accepted (review contract for run-state changes)
- **Created:** 2026-05-16
- **Updated:** 2026-10-17
- **Related:** [`live-to-final-assistant-replies.md`](live-to-final-assistant-replies.md), [`session-sse-contract-v1.md`](session-sse-contract-v1.md)

## Problem

A single agent turn is represented by several overlapping state layers:

- the visible transcript the user can read,
- the model context the agent actually receives,
- `pending_user_message` and active stream metadata,
- live SSE events and in-memory stream state,
- the durable run journal and replay state,
- automatic compression summaries and active-task handoff text,
- the client's live timeline state,
- sidebar ordering, unread state, and `updated_at` metadata.

When those layers drift apart, the user sees failures that look unrelated: a
prompt is visible but missing from recovered model context, a live run loses or
reorders thinking/tool rows after switching sessions, cleanup makes old sessions
look newly active, replay duplicates content, or compression reference material
appears inside the active turn.

This contract defines what must stay coherent across those layers.

## Goals

- Name the state layers involved in active and recovered turns.
- Make the source-of-truth expectation explicit for each layer.
- Give reviewers a checklist for streaming, replay, compression, recovery,
  model-context, and sidebar changes.

## Current implementation

The server owns every layer except the client's live timeline:

- `packages/server/src/sessions/turn.ts` admits turns, persists pending state,
  relays sidecar frames, and settles the transcript.
  Its `startServerTurn` admits leftover steers, goal continuations, and process
  wakeups through the same workspace recovery and model resolution as user
  turns. Admission failures start no worker; goal continuations report idle/error.
  Wakeups retain their runtime barrier and retryable stale-runtime deferral.
  A user's Stop (even one after `done`) holds that admission until the user's
  next turn is admitted: wakeups stay deferred for that turn's teardown, and a
  goal continuation reports idle/held. The session field
  `automatic_turns_held` carries the hold.
- `packages/server/src/sessions/streams.ts` (`StreamRegistry`) holds live
  channels, stream owners, and active runs.
- `StorageBackend.journals` owns durable run events. Its JSON adapter in
  `packages/server/src/sessions/storage/json-journal.ts` writes one JSONL journal per stream under `sessions/_run_journal/<sid>/<stream_id>.jsonl`.
- `packages/server/src/sessions/anchor.ts` builds the `activity_scene_v1` each
  completed turn carries, so Web and iOS render one projection of live,
  settled, replayed, and recovered activity.

The frontend's stream reducer (`packages/frontend/src/stream/reducer.ts`) is a
projection of SSE frames that converges on the server's settled fields.

The server's read-only `state.db` projection recognizes the released Agent's
exact in-flight request restatement. It compares the replay body with preceding
generations of the same `message_uid` within the selected session chain. Only an
unchanged timestamp copy or the known replay transformation inherits identity.
A payload change starts a new identity at its existing physical row ID, even
when both generations have already become compacted. Unknown transformations
stay distinct; UID equality alone never proves a copy.

The reader streams those histories once and reads the live rows and archive in
one SQLite snapshot. Its internal `_state_db_authored_change` marker prevents
the append-only merge's text fallback from hiding a known new occurrence behind
an older identical local row. A fixed-width fingerprint of a verified copy's
archived source also lets older sidecars match replays without a seen marker. The remaining rows still pass
through the existing timestamp, clear, truncation and compression gates. Both
internal markers are stripped from public messages.
The append-only merge also honors the Agent's explicit `_absorbed_row_ids` and
`_absorbed_message_uids` witnesses. A merged prompt represents those durable
occurrences even when it keeps an earlier timestamp or a different model-facing
prefix. Settlement uses the same identities for starting context and Agent-owned
work, so those occurrences cannot become concurrent external rows or consume a
text match belonging to a separate submission. Databases without UID columns keep
their existing exact-copy fallback. The reader's UID alias stays internal, and
archive-proven authored edits still require their own numeric identity.
Numeric identity includes the database generation. An untagged carrier can use
the last recorded marker's generation, which settlement preserves on the carrier
before replacing or clearing that marker. Recreated databases cannot inherit old
absorbed IDs; durable UIDs can still identify an occurrence across replacement.
The starting read captures its generation even when it has no message rows.
Turn settlement shares one forwarding path for successful, failed and stopped
turns, binding new Agent numeric witnesses to that starting generation. Existing
transcript witnesses keep their prior generation, including an explicit unknown
generation, and a replacement during the turn cannot inherit them.
Database-restored carriers retain the JSON `absorbed_message_uids` witness as
internal `_absorbed_message_uids`, including when the carrier itself was edited.
An incoming carrier is covered only when its own identity and every declared
constituent are represented; partial overlap cannot hide new work. Tool rows
never match by message UID, because their existing tool-call/timestamp rule owns
their compaction identity. Absorbed UID witnesses are stripped from public rows.
Tool results retain their existing tool-call/timestamp compaction rule; tables
without UIDs retain the legacy timestamp rule. This requires no Agent changes,
new database fields, release pins or server-side database writes.

## State layers

| Layer | Purpose | Source-of-truth expectation | Must not do |
|---|---|---|---|
| Visible transcript | Shows what the user and assistant said | Session transcript plus live replay produce one chronological user-visible story | Hide the user turn that started active work, or show internal recovery text as current user intent |
| Model context | Supplies conversation state to the agent | Includes the current visible user turn unless deliberately excluded with a user-visible reason | Let the agent resume from context that contradicts what the user can see |
| Pending turn metadata | Bridges submitted-but-not-yet-settled user input | Identifies the user turn and stream that own active work | Become a permanent duplicate transcript row after recovery |
| Live stream / SSE | Delivers active runtime events to clients | An observation path, not the only durable record of emitted events | Lose the visible scene on refresh, reconnect, or session switch |
| Active-run registry (`StreamRegistry.activeRuns`) | Tracks whether a worker still occupies the session, so a successor turn cannot start on top of it | Broader than "attachable": a cancelled worker stays registered while it unwinds | Be read directly as the set of runs a client may attach to |
| Run journal / replay | Rebuilds emitted runtime events after reconnect or restart | Cursor-safe and idempotent | Duplicate assistant text, thinking text, tool rows, or compression rows |
| Compression summary / handoff | Gives the agent recovery context after automatic compression | Agent-facing recovery material unless explicitly rendered as history | Pollute the active turn or become implicit current user intent |
| Client live timeline | Holds expanded rows, in-progress rows, scroll, and transient grouping | Rebuildable from transcript plus replay | Become the only place where chronological ordering exists |
| Sidebar/session metadata | Helps the user find active and recent sessions | Reflects meaningful user or assistant activity | Treat background cleanup as a fresh user-facing update |

## Core invariants

1. **Visible current turns enter model context.** If the user can see a current
   prompt and the server asks the model to continue that work, the prompt is in
   the reconstructed model context unless the server shows an explicit reason
   it was excluded.
2. **Active turn UI keeps its owner.** The user turn that started active work
   stays visible before the assistant text, thinking rows, tool rows, or
   activity groups that belong to that work.
3. **Reattach preserves order or degrades clearly.** Refresh, reconnect, and
   session switch preserve chronological live-scene order. If the exact live
   scene cannot be restored, the client shows an explicit structured replay
   state instead of silently reordering content.
4. **Maintenance is not activity.** Stale-stream cleanup, orphan repair, and
   background compression do not refresh sidebar ordering, unread markers, or
   active-session affordances as if the user or assistant just acted.
5. **Replay is idempotent.** Replaying a run from a cursor does not duplicate
   transcript rows, thinking content, interim assistant text, tool rows, or
   compression rows. Replayed events go through the same reducer as live SSE
   frames, so recovery never flattens a structured Thinking / progress / tool /
   compression turn into a separate presentation. Visible interim assistant
   progress stays visible timeline content; an Activity disclosure may
   summarize adjacent tool detail but is never the only place emitted progress
   text appears.
6. **Compression is not current intent.** Automatic compression summaries and
   reference rows are recovery and handoff material, never a new user request,
   active-turn content, or the default explanation for the current answer.
   During a live turn, automatic compression appears only as a quiet,
   non-interactive divider: `Compressing context` while active and
   `Context auto-compressed` once a completion event arrives or later tool,
   reasoning, or interim assistant events prove the barrier has passed. Settled
   history omits the live-only divider unless a visible recovery or error state
   needs it.
7. **Recovery work is bounded.** Session load and live-run reattach may project
   a recent journal window while preserving the latest durable cursor and total
   event count. They never parse, serialize, or render an unbounded active
   journal in one request. The append-only journal stays authoritative.
8. **Automatic turns have a distinct budget.** A process-completion wakeup turn
   (`sessions/completions.ts`) runs under its own retry and batch limits, and a
   limit exit is reported as an automatic-wakeup limit, never as a user
   cancellation. A wakeup that fails with `credential_pool_empty` records
   `process_wakeup_pause` (`sessions/wakeup-pause.ts`). Later wakeups are held
   in `sessions/_wakeup_held.json` (one atomic write, payload included) instead
   of starting a turn until the profile's credential state or the session's
   provider changes, the pool's earliest retry deadline passes, or a turn
   succeeds. A held wakeup leaves the file only once a turn admits it; the drain
   rechecks held sessions at least every five minutes, and its first pass after
   a restart resumes them. Delegation deferrals use this store before admission,
   including busy, sealed and Stop holds. A Stop's additive session metadata
   survives restart until the next admitted user turn. Completion acceptance is a
   session/profile-scoped delegation-to-stream receipt saved atomically with the
   pending automatic turn. A global Agent delivered flag or typed transcript row
   alone is not Web admission. Typed delivered results without a receipt reconcile
   through the existing drain, without resetting the Agent ledger.
9. **Observation has a degraded path.** Long-running or many-session
   observation exposes heartbeat or degraded status so the UI does not appear
   silent and ordinary APIs do not stall behind active streams.
10. **Detached completions follow their owner.** The session id captured when
    background work is commissioned proves ownership. Completions are routed to
    that exact owner before any busy-state check or transcript mutation; an
    unroutable completion is requeued rather than delivered to another session.
11. **Busy is not attachable.** `StreamRegistry.activeRunStreamForSession`
    answers "may a new turn start?"; `attachableRunForSession` answers "may a
    client attach a renderer?". Cancellation splits the two: the run stays
    registered as cancelling so a successor cannot overlap the unwinding
    worker, but its journal already ends in a terminal event. Session SSE
    recovery and status polling use the attachable predicate; admission uses
    the busy one. Reading the registry with a single meaning resurrects a
    cancelled run on every fresh subscription.

    Cancellation unwind is bounded: a run cancelled more than
    `CANCEL_UNWIND_CEILING_S` (180 s) ago **and** owning no live channel no
    longer blocks its session. Both conditions are required, and staleness is
    measured from the cancellation time, so a long turn cancelled moments ago
    is never mistaken for an orphan.
12. **Every mutation names its layer.** A PR touching streaming, recovery,
    context reconstruction, compression, replay, or sidebar metadata states
    which layer it changes and what regression proves the invariant still
    holds.

## Review checklist

- Which state layers does this change read or write?
- Which layer is the source of truth after this change?
- Can the visible transcript and model context diverge? If yes, is that
  deliberate and user-visible?
- What happens after client refresh, session switch, SSE reconnect, and server
  restart?
- Does replay rebuild the same scene without duplicates, through the same
  reducer path as live SSE?
- Can this change move a session in the sidebar without meaningful user or
  assistant activity?
- Does this change ask the active-run registry "may a turn start?" or "may a
  client attach?", and does it use the matching predicate?
- If it changes a reclamation window, what proves an in-flight cancellation is
  not evicted early, and that a wedged one is eventually freed?
- Can automatic compression or recovery text become visible active-turn
  content?
- What test or manual evidence proves the invariant?
