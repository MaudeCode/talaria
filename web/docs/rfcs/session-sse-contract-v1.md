# Session SSE Contract v1

- **Status:** Proposed
- **Author:** @rodboev
- **Created:** 2026-07-04
- **Tracking:** #4812

Refs #4812

---

## Problem

hermes-webui has no stable, cross-client contract for observing the lifecycle
of an individual session over SSE. Five or more future consumers — WebUI
reconnect/multi-tab, Android wrapper, iOS/PWA wrapper, desktop/TWA wrapper, and
test/CLI observers — each need a resumable, dedupe-safe event stream. Without a
shared contract, every client invents its own cursor, heartbeat, and event-type
semantics, multiplying coordination cost as new producers are added.

The maintainer asked for a docs-only RFC first, holding implementation until
sequence and replay semantics are settled (comment 2026-06-24T17:14:05Z,
2026-06-25T04:50:06Z on #4812). This document settles the contract vocabulary
against current source before any route is added.

## Goals

- Define the SSE envelope and event-type vocabulary for a proposed per-session
  stream `GET /api/sessions/{session_id}/events`.
- Specify replay identity using the existing run-journal cursor model.
- Specify the snapshot fallback for stale or evicted cursors.
- Document the distinction from the existing global session-list stream.
- Record open implementation gates that must be resolved before the endpoint
  ships.

## Non-goals

- This RFC does **not** implement `GET /api/sessions/{session_id}/events`. No
  route, handler, or related code is added in this PR.
- This RFC does **not** modify `GET /api/sessions/events` (the existing global
  session-list invalidation stream routed in `api/routes.py` and
  implemented by `_handle_session_events_stream()` in `api/routes.py`).
- This RFC does **not** replace or modify existing streams: `/api/chat/stream`,
  `/api/approval/stream`, or `/api/clarify/stream`.
- This RFC does **not** introduce Android, iOS, or PWA client code.
- This RFC does **not** claim Android/iOS background reconnect behavior or
  production proxy delivery; those require owner-reaching proof in a later
  implementation PR.
- This RFC does **not** promise a new session-global sequence counter in Phase 1.

## Current source inventory

### Existing global session-list stream

`GET /api/sessions/events` is a **different endpoint** from the one this RFC
proposes. It is routed in `api/routes.py` and implemented by
`_handle_session_events_stream()` in `api/routes.py`. It emits bare
`sessions_changed` events and keepalives for any change to the session list. It
is a global invalidation signal, not a per-session lifecycle stream. The proposed
`GET /api/sessions/{session_id}/events` is per-session and path-distinct.

### Heartbeat

`_SSE_HEARTBEAT_INTERVAL_SECONDS = 5` (defined in `api/routes.py`) is the current
heartbeat interval for SSE streams. Phase 1 reuses this constant rather than
adding a separate configurable knob.

### Run-journal cursor and replay

Current replay identity is run/stream-scoped:

Symbols in this inventory were verified against WebUI `master` when this RFC
was written. Function, constant, and endpoint **names** are the stable anchors:
this RFC deliberately cites them by name (not by line number) so a source-layout
shift in `api/routes.py` cannot invalidate the doc or its contract test.

- `_parse_run_journal_event_id()` and `_parse_run_journal_after_seq()` (both in
  `api/routes.py`) parse the replay cursor from the `after_event_id` /
  `after_seq` **query params** (not the
  `Last-Event-ID` header — that header is the *proposed* new-endpoint contract
  below, §Reconnect).
- `_runner_event_id()` (in `api/routes.py`) constructs the event `id`
  field as `stream_id:seq`.
- SSE frames carry their `id:` via the `_sse_with_id()` helper, emitted on the
  live `/api/chat/stream` path, on the runner-observe path, and during journal
  replay — all in `api/routes.py`.
- `_replay_run_journal()` (in `api/routes.py`) reads events by
  `(session_id, stream_id)`.
- `api/streaming.py` writes current live agent streams to
  `STREAMS[stream_id]`.
- `api/streaming.py` appends SSE events to the run journal and carries
  per-item `event_id` into the live queue.

The existing run journal represents `session_id`, `stream_id`, `seq`, and
`event_id`, but **not** a session-global monotonic sequence. Phase 1 must not
promise a session-global counter because current source does not provide one.

## Proposed endpoint

```
GET /api/sessions/{session_id}/events
```

This endpoint is **path-distinct** from `GET /api/sessions/events`. The
`{session_id}` path segment is required; the global endpoint has no such segment.

Response: `Content-Type: text/event-stream`. Authentication and session
visibility checks reuse existing mechanisms.

## Envelope

Each SSE event carries a JSON payload with this structure:

```json
{
  "schema_version": 1,
  "session_id": "<session_id>",
  "event_type": "<string>",
  "event_id": "<opaque cursor>",
  "stream_id": "<stream_id>",
  "seq": <integer>,
  "emitted_at": "<ISO-8601 UTC>",
  "payload": { ... },
  "meta": { ... }
}
```

- `schema_version`: integer, always `1` for Phase 1 events.
- `session_id`: the session this event belongs to.
- `event_type`: one of the event types listed in the taxonomy below.
- `event_id`: opaque client cursor (see Cursor and resume semantics).
- `stream_id`: the run journal stream this event came from, if applicable.
- `seq`: monotonic within a stream/run (see Cursor and resume semantics).
- `emitted_at`: server-side emission timestamp in ISO-8601 UTC.
- `payload`: event-type-specific data.
- `meta`: optional; reserved for tracing and debug metadata.

Server-generated events that do not originate in the run journal, currently
`heartbeat` and `session_snapshot`, need an explicit `event_id` / `stream_id` /
`seq` rule before implementation. This RFC records that as an implementation
gate rather than inventing values without source support.

## Event taxonomy (Phase 1 draft)

> **Semantic names below are aspirational for the per-session endpoint.** Live
> `/api/chat/stream` wire names are listed in **Authoritative emitted events**
> immediately after this table — use those when writing clients against current
> source.

| event_type | Source | Description |
|---|---|---|
| `chat_delta` | run journal / live stream | Token or chunk from an assistant reply. |
| `tool_call` | run journal / live stream | Tool invocation record. |
| `tool_result` | run journal / live stream | Tool result record. |
| `approval_request` | run journal | Approval prompt sent to the user. |
| `clarify_request` | run journal | Clarification prompt sent to the user. |
| `run_started` | run journal | Run entered active state. |
| `run_finished` | run journal | Run reached a terminal state (complete, cancelled, error). |
| `session_snapshot` | server fallback | Current session projection; emitted when replay is unavailable. |
| `heartbeat` | server | Keepalive emitted on the `_SSE_HEARTBEAT_INTERVAL_SECONDS` cadence. |

## Authoritative emitted events (`/api/chat/stream`)

These are the **real wire `event:` names** emitted by `api/streaming.py` today
(23 names). Clients and docs must use this table — not the semantic draft above —
when integrating with the live chat SSE relay.

| Wire name | Role |
|---|---|
| `token` | Assistant text delta |
| `reasoning` | Model reasoning / thinking delta |
| `tool` | Tool call started; required `id` names the call |
| `tool_complete` | Tool call finished; carries the same `id` as its `tool` frame, the server's `is_error`, and `duration` (seconds between the server receiving the call's start and its completion) |
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
| `done` | Turn finalized (session payload); title/`stream_end` may follow |
| `stream_end` | SSE fence — close the client EventSource |
| `metering` | Token/cost metering snapshot |
| `context_status` | Context window / usage status |
| `goal` | Goal / plan card update |
| `goal_continue` | Goal continuation signal |
| `pending_steer_leftover` | Leftover steer text after interrupt |
| `steer_consumed` | User steer inserted into the active run, with stable `steer_id`, text, and consumption timestamp |
| `state_saved` | Durable state write acknowledgment |
| `todo_state` | Todo / checklist panel update |

Tool call identity: the server gives every `tool` / `tool_complete` frame one
`id`. It is the Agent's tool-call id; when the Agent supplied none, the server
mints `tool-<stream_id>-<n>` at `tool` and gives it to the completion that pairs
with that call (newest unfinished call of the same name). Clients settle a card
by `id` only. `steer_consumed.after_tool_call_id` names the same `id`. Public
frames never carry the sidecar-internal `tid`; journal rows written before this
field replay with `tid` mapped to `id`.

Relay close set (stop draining the live queue): `stream_end`, `cancel`,
`apperror`, and legacy `error` — see `api.run_journal.SSE_RELAY_CLOSE_EVENTS`.
`done` is **not** a relay-close event because `title` and `stream_end` follow it.

The semantic taxonomy table remains a draft for the proposed per-session
endpoint vocabulary and must be confirmed during maintainer review before that
endpoint claims parity.

## Cursor and resume semantics

`Last-Event-ID` is the standard SSE reconnect header. Clients send the last
`event_id` value seen on reconnect; the server uses it to resume replay from that
position.

**`event_id` is opaque to clients.** Its current source-compatible form is
`stream_id:seq`, as constructed by `_runner_event_id()` in `api/routes.py`.
Clients must treat it as an opaque string and must
not parse or construct cursor values.

**`seq` is monotonic within a stream/run.** It is not a session-global counter
and is not promised to increase monotonically across streams or runs. Phase 1
does not claim a pre-existing session-global sequence because current source does
not provide one.

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

The session-level `tool_calls` list stays for older clients; its entries also
carry `is_error` and `duration`.

## Replay source

Phase 1 uses the **durable run journal** as the replay source for replayable
events. The live `STREAMS[stream_id]` queue (in `api/streaming.py`) is
not a reliable replay source because it holds only recent in-memory state.

There is one explicit availability exception: if the run-journal writer cannot
initialize or append (for example, a transient filesystem failure), the active
chat continues to receive the live event, but that frame has no `event_id` and
is not claimed as replayable. The server logs the degraded journal once per run;
reconnect recovery must use the session snapshot or settled transcript for the
uncommitted gap. A journal failure must never attach a cursor to an event that
was not flushed to the journal.

A future implementation must replay from the run journal via the existing
`_replay_run_journal()` path (in `api/routes.py`) and fall back to the
snapshot mechanism when journal entries are unavailable for a given cursor.

## Snapshot fallback

When the `Last-Event-ID` cursor is evicted, expired, unknown, or refers to a
stream that is no longer replayable, the server must:

1. Emit a `session_snapshot` event containing the current session projection.
2. Continue the live stream from the present without pretending that missed
   events were replayed.

`session_snapshot` is a recovery boundary, not proof of exact missed-event
replay. Clients receiving a snapshot must treat prior cursor state as invalid and
resync from the snapshot payload.

## Heartbeat

Phase 1 reuses `_SSE_HEARTBEAT_INTERVAL_SECONDS` (defined in `api/routes.py`) for
heartbeat cadence. A new per-session configurable heartbeat knob is **not** added
in Phase 1. The implementation PR must follow whatever value the constant holds
at implementation time; it must not hard-code a separate interval.

## Security and privacy

- Reuse existing auth and session visibility checks. A client must not be able to
  subscribe to events for a session it does not own.
- Payloads must not include credentials, raw provider API keys, or unsanitized
  internal error details.
- `meta` fields are for tracing and debug metadata and must not carry
  security-sensitive values in production.

## Implementation gates (open questions)

The following decisions must be resolved before any implementation PR for this
endpoint is accepted:

1. **Sequence semantics**: Maintainer must confirm that stream/run-scoped `seq`
   (not session-global) is acceptable for Phase 1 clients.
2. **Retention policy**: How long are run journal entries retained for replay?
   What is the eviction boundary that triggers the snapshot fallback?
3. **Event-type table**: The taxonomy above is a draft. The complete event-type
   list must be confirmed during review of this RFC.
4. **Auth behavior on reconnect**: Does `Last-Event-ID` replay require the same
   auth token, or can it continue across token refresh?
5. **Client proof**: At least one browser-based client (WebUI) and at least one
   non-browser client (Android wrapper or CLI) must provide owner-reaching
   reconnect proof before implementation closes #4812.
6. **Proxy and keepalive**: The 5 s heartbeat choice must survive real proxy
   deployments. This requires manual-owner-proof or standards-doc evidence in the
   implementation PR.
7. **Server-generated event identity**: Maintainer must confirm how
   `heartbeat` and `session_snapshot` populate `event_id`, `stream_id`, and
   `seq`, because those events do not originate in the run journal.

## Bypass risks

Future implementation work must not:

- Introduce an in-memory-only cursor that bypasses the run journal.
- Conflate `GET /api/sessions/events` (global session-list invalidation) with
  `GET /api/sessions/{session_id}/events` (per-session lifecycle).
- Promise a session-global monotonic sequence without defining a migration from
  the current stream/run-scoped model.

Tests in `tests/test_issue4812_session_sse_contract_rfc.py` assert these
boundaries so review catches regressions against this contract.

## Rollout plan

1. This RFC is accepted by maintainer review on #4812.
2. Retention and event-type decisions are confirmed.
3. Client proof (browser + non-browser) is provided.
4. An implementation PR adds `GET /api/sessions/{session_id}/events` following
   this contract vocabulary.
5. Implementation PR closes #4812.
