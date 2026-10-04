# Session SSE Contract v1

- **Status:** Implemented
- **Created:** 2026-07-04
- **Updated:** 2026-09-27

## Endpoints

| Endpoint | Scope |
|---|---|
| `GET /api/chat/stream?stream_id=` | One run's live events, with journal replay on reconnect. |
| `GET /api/sessions/{session_id}/events` | Per-session relay: replays the session's run journal from a cursor, then follows the active run. |
| `GET /api/sessions/events` | Global session-list invalidation (`sessions_changed`); not a lifecycle stream. |

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
| `tool_complete` | Tool call finished; carries the same `id` as its `tool` frame, the server's `is_error`, `duration` (seconds between the server receiving the call's start and its completion), and `result_view` (TAL-315, below) |
| `interim_assistant` | Mid-turn assistant prose (pre-final) |
| `approval` | Destructive-command approval prompt |
| `clarify` | Structured clarification prompt |
| `compressing` | Context compression started |
| `compressed` | Context compression finished |
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
| `pending_steer_leftover` | Leftover steer text after interrupt |
| `steer_consumed` | User steer inserted into the active run, with stable `steer_id`, text, and consumption timestamp |
| `state_saved` | Durable state write acknowledgment |
| `todo_state` | Todo / checklist panel update |
| `bg_task_complete` | Background process or delegation finished for this session |
| `server_turn_started` | A server-side turn (wakeup, recovery) started on this session |

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

Every stream sends an SSE comment every `SSE_HEARTBEAT_INTERVAL_MS` (5 s) when
it has nothing else to send.

## Security and privacy

- The relay uses the normal auth gate and answers 404 for a session outside
  the request's profile, so a client cannot subscribe to a session it cannot
  see.
- Journal rows pass through the same public-payload redaction as the live
  stream: no credentials, provider API keys, or unsanitized internal error
  details.
