# Session SSE Contract v1

- **Status:** Implemented
- **Created:** 2026-07-04
- **Updated:** 2026-10-23

## Endpoints

| Endpoint | Scope |
|---|---|
| `GET /api/chat/stream?stream_id=` | One run's live events, with journal replay on reconnect. |
| `GET /api/sessions/{session_id}/events` | Per-session relay: replays the session's run journal from a cursor, then follows the active run. |
| `GET /api/sessions/events` | Global session-list invalidation (`initial` then `sessions_changed`); not a lifecycle stream. |
| `GET /api/session/stream?session_id=` | Viewed-session invalidation across idle and running periods. |

Web's transcript hook and App's existing session-event transport keep the viewed
session's stream open. `session-updated`, `server_turn_started`,
`bg_task_complete`, and `process_complete` invalidate authoritative session detail.
Web sends the cached server-owned `message_count` as `known_count` when available,
including zero, so subscribe recovery can signal missed persisted messages. Its
first `initial` leaves the ordinary mount fetch/cache policy in charge; subsequent
`initial` frames resync once per reconnect. Window focus does not refetch the open
transcript. Cancelled detail, list and search queries abort their HTTP transport
while retaining their existing request deadlines. Caller-cancellable reads own
independent transports, and an already-aborted read never reaches the transport;
reads without caller cancellation retain in-flight coalescing. Consecutive identical queued
`session-updated` signals coalesce for stalled subscribers; distinct payloads and
intervening events keep their order.
The global sidebar feed remains independent. Reconnection refreshes detail even
when no change was retained while the client was absent.

The global sidebar feed sends `initial {stream: "sessions"}` first on every
connection, including `?gateway=1`. Web subscribes to that merged feed so external
Agent session changes also invalidate the sidebar. It uses `initial` to resync
list and search queries once per connection. The visible-tab 60-second fallback
polls only when this EventSource is not OPEN; a healthy stream needs no periodic
list rebuild.

Web installs a terminal chat frame's complete session directly into its query
cache, cancelling older detail reads. Terminal snapshots and initial transcript
queries share `TRANSCRIPT_WINDOW` in the contracts package, currently 120 visible
rows. Terminal settlement refreshes list and search queries without fetching
detail again; a following title frame patches the cached title. For five seconds
after a complete terminal snapshot, a named sidebar echo refreshes that session's
other queries while retaining its transcript. Other sessions stay cached.
When `session_done` arrives before the terminal frame, a client following that
run leaves detail to the live transport; a lost terminal frame still uses the
existing stream-end/status reconciliation. A window whose offset advances
retires the loaded prefix and in-flight history pages so absolute row indices
remain correct; history can be loaded again from the new boundary.
Explicit mutations still refresh the affected session. On the viewed-session
feed, the identical `process_complete` immediately following `bg_task_complete`
is its legacy alias and causes no second detail fetch. Reconnects, owner updates,
and standalone legacy completions retain their detail refresh.

For canonical native chats, authorized viewers and an active run share one
attach-only native subscription, keyed by profile home and session. The last
viewer releases its lease without interrupting a run; the last lease closes the
native subscription. Idle observation creates no active stream or Agent admission.
Native transport loss closes the viewed-session HTTP stream so its existing client
reconnect policy reattaches. Stream slots, disconnects and backpressure retain the
HTTP SSE owner's cleanup path.

Native plugin post/edit events replace notices by owner/replay/session-scoped key.
Session launch `config_warning` uses the same existing `notices` field and renderer.
Notice events require session and replay identity plus ordered sequence; turn
frames retain their execution-generation fences. A replay gap clears ephemeral
native notices and restores the snapshot warning. It cannot reconstruct plugin
history absent from the owner's replay. Direct notices and global startup-warning
placement are unchanged.

The per-session relay lives in `handleSessionJournalStream`
(`packages/server/src/api/sse-routes.ts`). It relays journal rows with their
original wire names and `event_id` as the SSE `id:`; there is no extra
envelope. [`docs/sse-streams.md`](../sse-streams.md) lists the other streams.

## Chat stream events

`CHAT_EVENT_NAMES` and `ChatEventSchema` in `packages/contracts/src/sse.ts` are
the canonical list of wire `event:` names and payloads for `/api/chat/stream`
and the per-session relay. The chat-turn events:

| Wire name | Role |
|---|---|
| `token` | Assistant text delta |
| `reasoning` | Model reasoning / thinking delta |
| `tool` | Tool call started; required `id` names the call |
| `tool_progress` | Ephemeral `{id, progress: {percent, message}}` for a running MCP call; percentages are server-normalized and messages redacted. Not journaled; an active-stream attach includes the latest in-memory value after replay. |
| `tool_complete` | Tool call finished; carries the same `id` as its `tool` frame, the server's `is_error`, `duration` (seconds between the server receiving the call's start and its completion), and `result_view` (TAL-315, below) |
| `interim_assistant` | Mid-turn assistant prose (pre-final) |
| `approval` | Destructive-command approval prompt |
| `clarify` | Structured clarification prompt |
| `compressing` | Context compression is running; `started_at` (epoch seconds) is the span's start, the same on every heartbeat |
| `compressed` | Context compression finished; it closes the span mid-turn, before the turn's next content frame |
| `title` | Session title update (often after `done`) |
| `title_status` | Title generation status / skip reason |
| `warning` | Non-fatal provider/fallback warning |
| `apperror` | Terminal application error (no trailing `stream_end`) |
| `cancel` | Run cancelled |
| `done` | Turn finalized (session payload); title, goal and `stream_end` may follow |
| `stream_end` | SSE fence — close the client EventSource |
| `metering` | Token/cost metering snapshot |
| `context_status` | Context window / usage status |
| `goal` | `/goal` progress after a goal turn: `state` `evaluating`, then `continuing` or `idle` with the Agent's verdict and message |
| `goal_continue` | The server started the goal's continuation turn (`stream_id`, `continuation_prompt`) |
| `steer_consumed` | User steer inserted into the active run, with stable `steer_id`, text, and consumption timestamp |
| `state_saved` | Durable state write acknowledgment |
| `todo_state` | Todo / checklist panel update |
| `bg_task_complete` | Background process or delegation finished for this session |
| `server_turn_started` | A server-side turn (wakeup, recovery) started on this session |
| `notices` | The session's Agent notices changed (TAL-803); `notices` replaces the session's `notices` list |
| `session_goal` | The session's standing `/goal` changed (TAL-808); `goal` replaces the session's `goal` |
| `rate_limit_wait` | The Agent is sitting out a provider rate limit (TAL-821): `wait` is `{provider, provider_label, until, until_kind}` (`until`, epoch seconds: the limit's reset, or the Agent's retry when the provider named no reset), or `null` once the Agent retries or streams; the turn's terminal frame ends it too |

Tool call identity: the server gives every `tool` / `tool_complete` frame one
`id`. It is the Agent's tool-call id; when the Agent supplied none, the server
mints `tool-<stream_id>-<n>` at `tool` and gives it to the completion that pairs
with that call (newest unfinished call of the same name). Clients settle a card
by `id` only. `steer_consumed.after_tool_call_id` names the same `id`. Public
frames never carry the sidecar-internal `tid`; journal rows written before this
field replay with `tid` mapped to `id`.

Relay close set (stop draining the live queue): `stream_end`, `cancel`,
`apperror`, and legacy `error` (`RELAY_CLOSE_EVENTS`).
`done` is **not** a relay-close event because `title` and `stream_end` follow it.

Web caches a terminal frame's settled session directly, refreshing session lists
and that session's other metadata without refetching transcript detail. Terminal
frames without a session retain the detail-refresh fallback. Admitting a live
turn refreshes only session lists and that session's status.
Terminal sessions share the detail endpoint's indexed projection and transcript
window, including activity scenes, tool outcomes, pagination offsets and todo state.

## Cursor and resume semantics

`/api/sessions/{session_id}/events` resumes from `Last-Event-ID` (or the
`after_event_id` query parameter). `/api/chat/stream` resumes from
`after_event_id`, `after_seq`, or `Last-Event-ID`, in that order.

**`event_id` is opaque to clients.** The server builds it as `stream_id:seq`;
clients treat it as an opaque string and never parse or construct cursor
values.

**`seq` is monotonic within a stream/run.** It is not a session-global counter
and does not increase across streams or runs.

**Clients dedupe by `event_id`.** If a reconnect causes overlap with already-seen
events, clients use `event_id` to detect and skip duplicates.

## Session detail transcript cursor

`GET /api/session` states where its `messages` end in the active run's journal
as `transcript_seq: { stream_id, seq } | null` (TAL-316). The guarantee is that
`messages` hold nothing the journal of `stream_id` delivers after `seq`, so a
client opens that stream with `after_seq = seq` and renders the replay as-is,
without matching replayed text against the transcript.

- For an active run with a journal, the server leaves the running turn's output
  to the replay: it keeps the turn's prompt and its persisted steer rows, drops
  every other row of that turn, and returns `{ stream_id: active_stream_id,
  seq: 0 }`. It cannot map individual state.db rows to journal sequence
  numbers, so the cursor is true by construction rather than by lookup.
- With no active run, or when the run has no journal (degraded or pruned),
  `messages` are the whole persisted transcript and `transcript_seq` is `null`;
  the client attaches live without replay.
- An active run's prompt is always in `messages`, exactly once, before its
  activity (TAL-368). Deferred save keeps it out of the sidecar until
  settlement, so the detail projects `pending_user_message` and
  `pending_attachments` as the turn's user row (`_turn_id: active_stream_id`,
  `_active_turn_user: true`) unless a row for that run already exists: its
  checkpoint, a row stamped with its id, or a state.db prompt past the sidecar
  at or after `pending_started_at`; a state.db prompt takes the pending text,
  turn id, and attachments. Run identity decides, never text, so a repeated
  prompt is its own row. The projection is read-only; settlement
  replaces it with the canonical row.
- Windowing (`msg_limit` / `msg_before`) applies after the projection and the
  omission, so every window agrees on `message_count` and the cursor.
- Reconnects within one client keep that client's own same-stream cursor. A
  cursor whose stream id differs from the target stream is never used.

## Persisted tool call outcomes

Every assistant row's `tool_calls` leave the server resolved (TAL-313), in
session detail (every window), mutation replies, and terminal payloads. The
projection runs over the full transcript before windowing and writes nothing
back to the session file.

- Anthropic `tool_use` content parts also appear in `tool_calls` in the OpenAI
  shape (`{ id, type: 'function', function: { name, arguments } }`); the
  content keeps its parts. A call only the session-level `tool_calls` list
  recorded joins the assistant row at its `assistant_msg_idx`.
- `done`: the call has a result, or it belongs to a turn other than the running
  one. A running turn's unanswered call is `done: false`.
- `is_error`: the server's one outcome rule over the call's result: an object
  with a non-empty `error`, a non-zero numeric `exit_code` / `exitCode`, or
  `success: false`. Live `tool_complete` frames use the same rule over the
  sidecar's raw result, which never leaves the server.
- `duration`: the seconds the live stream measured for that call id, else
  `null` (history written before the server recorded durations).
- `result`: the redacted result snippet, else `null`.
- `result_view` (TAL-315): the result's display sections, else `null`:
  `{ text?, stdout?, stderr?, error?, exit_code? }`. One server rule decides
  them for live `tool_complete` frames (from the sidecar's raw result, so
  `stderr` and `exit_code` survive), persisted calls, and scene tool rows. A
  JSON result (nested JSON strings unwrapped, escaped line breaks undone) with
  `output` / `stdout` / `stderr` maps to its terminal sections; another object
  shows the first readable `result`, `results`, `preview`, `content`, `text`,
  `message`, `summary`, `data` or `items`, else its `error` and exit code, else
  pretty JSON. `exit_code` is sent only when it is non-zero or nothing else
  shows. Each string is redacted and capped at 4000 characters. Clients show
  the fields present in that order, with localized `Error:` / `Exit code:`
  labels, and show `preview` only when the field is absent.

The session-level `tool_calls` list stays for older clients; its entries also
carry `is_error` and `duration`.

## Replay source

The durable run journal (`packages/server/src/sessions/journal.ts`) is the
replay source. The in-memory stream channel holds only recent state and is
never a replay source.

If the journal writer cannot initialize or append (for example, a transient
filesystem failure), the active chat still receives the live event, but that
frame has no `event_id` and is not claimed as replayable. The server logs the
degraded journal once per run; reconnect recovery uses the session snapshot or
settled transcript for the uncommitted gap. A journal failure never attaches a
cursor to an event that was not flushed to the journal.

Settled journals older than `HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS` (14) are
compacted to summaries, keeping the `HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT` (3)
newest per session; a cursor into a compacted run falls back to a snapshot.

### Settled prompts

A replay never re-opens a prompt that its run already settled. This covers
chat replay, per-session journal replay, backfill of frames dropped for a slow
reader, and the buffered frames a new subscriber receives from the channel. The
server omits an `approval` or `clarify` frame when later rows of the same run
prove it settled:

- a terminal row (`done`, `cancel`, `apperror`, `error`, `stream_end`)
  settles every prompt before it;
- a `tool_complete` named `clarify` settles every question before it. The Agent
  never runs `clarify` in parallel. This evidence never settles an approval,
  because the approval queue writes no per-entry settlement row.

Rows from another run never count as evidence. Pending prompts stay visible, and
so do rows with no positive seq or run, and prompts whose only evidence is
unreadable. A `clarify` frame with `status: "resolved"` is a notice, not a
prompt, and is always sent. Every other frame keeps its original `id`, so
cursors, `maxSeq` cut-offs and gap checks still use journal seqs. The server
looks for evidence only inside the replay's own window: the paged journal range
it is already reading, or the rows already loaded for a session replay. Clients
receive the existing events, minus the settled prompts, and need no new field.

## Snapshot fallback

When the resume cursor is unknown, evicted, or refers to a run that is no
longer replayable, the per-session relay emits `session_snapshot`
(`{ session }`, the compact session projection) and continues from the present
without pretending that missed events were replayed. While no run is active it
also emits a snapshot whenever the session's journal changes.

`session_snapshot` is a recovery boundary, not proof of exact missed-event
replay. Clients receiving one treat prior cursor state as invalid and resync
from the snapshot.

## Heartbeat

Canonical owner observations use the same chat stream, with an initial `session_snapshot` followed by
normalized events from the authenticated owner. The snapshot replaces local live text and prompt state;
its server-owned session fields remain authoritative. `replay_gap: true` means the native ring could not
replay the missing prefix. Web clears that prefix, reports the gap, and converges on the owner's final
snapshot. It never appends an uncertain prefix as if it were complete. Native epoch and generation
checks precede event forwarding. Observation journals are scoped by profile home and logical session;
they are not another execution ledger or transcript writer. Detaching a viewer only releases its
subscription. Stop is a separate generation-fenced owner operation.

Every stream sends an SSE comment every `SSE_HEARTBEAT_INTERVAL_MS` (5 s) when
it has nothing else to send.

## Security and privacy

- The relay uses the normal auth gate and answers 404 for a session outside
  the request's profile, so a client cannot subscribe to a session it cannot
  see.
- Journal rows pass through the same public-payload redaction as the live
  stream: no credentials, provider API keys, or unsanitized internal error
  details.

## Background result review

Background completion lines carry optional server-owned `review_state` fields.
The update's state describes the parent; each line composes that review with
its worker outcome, preserving failed or unknown worker results. The states are
`waiting`, `reviewing`, `reviewed`, `failed`, and `unknown`. Clients show one
leading icon and the goal, with localized state descriptions in accessibility
and help text.

Admission saves the structured update with the pending turn. Only the results
admitted to that turn share its review. Waiting requires a durable held result that no parent has admitted; a pending
delivery acknowledgement alone is not a pending review. Reviewing requires its
live parent run. Successful settlement persists terminal
evidence on the background prompt, alongside the actual final reply. A silent
marker alone or a delivered ledger flag cannot establish review. Interrupted
or missing runs remain Unknown unless their result is durably pending for retry.
Indexed pages resolve off-page parent proof through the existing turn index;
they never enumerate the cached transcript prefix for review state. The same
projection precedes terminal payloads and every session window. Its
persisted metadata is additive, and clients keep the explicit values in cache.

### Provider prompt-reading status

`run_status` carries `{session_id, status}`. The server selects `status.phase` in this order:
`compressing`, `rate_limit_wait` (with the existing `wait` object), `prompt_reading`
(with `progress_percent` from 0 through 100, or null when unknown), then `working`.
Session detail and the journal stream's `session_snapshot` fallback include the same current
`run_status` so an attach beyond earlier progress frames still shows the current phase.
Older servers omit this additive field. A retained stream keeps its status with its consumed cursor;
reattachment replays newer status frames instead of replacing them with an unversioned cached session.

The sidecar recognizes the Agent's exact local prompt-progress status line and forwards
`provider_phase`, including explicit null clears. Ordinary reasoning text is never progress.
The ordered turn publisher normalizes percentages, journals status before publishing it,
and clears provider progress on content, explicit clear, Stop, error, completion, or replacement.
Terminal `run_status: null` cannot be reopened by post-turn title or metering events.
Clients localize the selected phase and format the percentage without deciding precedence.

### Live MCP progress

The sidecar forwards the Agent's throttled `tool.progress` callbacks as `tool_progress`.
The server matches the exact running call id, normalizes finite percentages to 0..100
using `progress/total` when no percent is supplied, and caps the redacted message.
`progress` is optional on tool display contracts for older servers. Completion sends
`progress: null`; terminal events clear every remaining value. Progress is kept only
in the live turn and channel reconnect snapshot, never in the journal or transcript.
Session detail includes the current values on its live `tool_calls`, including a
mid-turn reload. Older Agents that do not emit progress retain their existing rows.

## Session activity across foreground completion

Session detail, status, replay-gap snapshots, terminal-frame `session` data,
`/api/chat/stream/status`, and `/api/background/tasks` carry optional
`activity_phase`. It uses `starting`, `running`, `waiting_for_approval`,
`waiting_for_input`, `completed`, `failed`, `cancelled`, or `stale` independently
of the turn's unchanged `terminal_state`. The existing background owner confirms
its durable receipts against current Agent registries or local command streams.
Prompts and a live foreground turn retain priority. Remaining confirmed work
keeps the session running; unconfirmed work makes it stale. Settled background
failures and cancellations cannot become success. Old servers omit the additive
field and clients retain their existing turn-outcome fallback.

The Relay publisher reconciles background receipts on its existing event-driven
and heartbeat publication, including sessions after foreground retention and a
publisher restart. It signs the same decision as `activityPhase`, while `phase`
and `streamId` retain the turn outcome and completion identity. No viewer or
widget polling owns this lifecycle.

Activity outcomes and timestamps reuse the revision-owned transcript prefix
index, including cached pages and publisher reloads. A `/background` worker's
activity parent is recorded at admission, so its hidden session adds no second
activity. Native streams release admission before activity reconciliation but
retain their channel through `done` and `stream_end`.
