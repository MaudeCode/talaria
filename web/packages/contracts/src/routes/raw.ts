/**
 * Byte-stream routes the server implements outside oRPC (file bodies, ZIP
 * streams, multipart uploads, downloads). They are documented here so the
 * generated OpenAPI document covers every HTTP path a consumer may call.
 */


export interface RawRoute {
  method: 'GET' | 'POST'
  path: string
  summary: string
  tags: string[]
  query?: Record<string, { description: string; required?: boolean }>
  requestBody?: { contentType: string; description: string }
  /** One media type, or several when the route answers different ones (an SSE route's JSON probe). */
  responses: Record<number, { description: string; contentType?: string | string[]; headers?: Record<string, string> }>
}

export const RAW_ROUTES: readonly RawRoute[] = [
  {
    method: 'GET', path: '/api/auth/oidc/start', summary: 'Redirect the browser to the configured OIDC provider (302, `Cache-Control: no-store`).', tags: ['auth'],
    query: { next: { description: 'Safe path-absolute return target after login.' }, native_flow: { description: 'Pending native handoff id from `/api/auth/oidc/native/start`.' } },
    responses: { 302: { description: 'Provider authorization URL in `Location`.' }, 404: { description: 'OIDC is not configured.', contentType: 'application/json' }, 502: { description: 'Provider discovery failed.', contentType: 'application/json' } },
  },
  {
    method: 'GET', path: '/api/auth/oidc/callback', summary: 'Authorization-code callback: verifies the id_token, sets the session cookie, and redirects to `next` (or the native app).', tags: ['auth'],
    query: { state: { description: 'Opaque state issued by `/api/auth/oidc/start`.', required: true }, code: { description: 'Provider authorization code.' }, error: { description: 'Provider error code (yields 401 or a native failure redirect).' }, error_description: { description: 'Provider error detail.' } },
    responses: { 302: { description: 'Session established; `Set-Cookie` plus `Location`.' }, 400: { description: 'Missing state or code.', contentType: 'application/json' }, 401: { description: 'Provider error or claim policy rejection.', contentType: 'application/json' }, 404: { description: 'OIDC is not configured.', contentType: 'application/json' } },
  },
  {
    method: 'GET', path: '/api/chat/stream', summary: 'Live agent-turn relay (SSE). Journal-backed frames carry `id: <stream_id>:<seq>`; resume with `after_event_id`, `after_seq`, or `Last-Event-ID`.', tags: ['chat'],
    query: { stream_id: { description: 'Stream returned by `/api/chat/start`.', required: true }, after_event_id: { description: 'Resume cursor (`<stream_id>:<seq>`).' }, after_seq: { description: 'Numeric resume cursor.' }, replay: { description: '`1` replays the journal from the start.' } },
    responses: { 200: { description: 'Event stream; ends after `stream_end`, `cancel`, `apperror`, or `error`.', contentType: 'text/event-stream' }, 404: { description: 'No live stream and no journal.', contentType: 'application/json' }, 503: { description: 'Client stream limit reached (`condition: client_stream_limit`).', contentType: 'application/json' } },
  },
  {
    method: 'GET', path: '/api/session/stream', summary: 'Persistent per-session channel (`initial`, `server_turn_started`, `session-updated`, `bg_task_complete`).', tags: ['chat'],
    query: { session_id: { description: 'Session to follow.', required: true }, known_count: { description: 'Last message count the tab rendered; a higher persisted count triggers `session-updated`.' } },
    responses: { 200: { description: 'Event stream with 5 s keepalives.', contentType: 'text/event-stream' } },
  },
  {
    method: 'GET', path: '/api/sessions/events', summary: 'Global session-list invalidation stream (`sessions_changed`).', tags: ['sessions'],
    query: { gateway: { description: '`1` merges the gateway feed with a `stream` discriminator and an initial `gateway_status` frame.' } },
    responses: { 200: { description: 'Event stream.', contentType: 'text/event-stream' } },
  },
  {
    method: 'GET', path: '/api/sessions/gateway/stream', summary: 'Standalone gateway-session feed: an initial `sessions_changed {sessions}` snapshot, then the watcher events, with `: keepalive` comments. `/api/sessions/events?gateway=1` carries the same feed merged.', tags: ['sessions'],
    query: { probe: { description: '`1` answers the stream status as JSON instead of streaming (`scope: gateway_sessions`).' } },
    responses: { 200: { description: 'Event stream, or the probe JSON with `probe=1`.', contentType: ['text/event-stream', 'application/json'] }, 404: { description: 'Agent sessions are not enabled (`show_cli_sessions`).', contentType: 'application/json' }, 503: { description: 'The gateway watcher is not running, or the client stream limit is reached.', contentType: 'application/json' } },
  },
  {
    method: 'GET', path: '/api/sessions/{session_id}/events', summary: 'Per-session run-journal relay with `Last-Event-ID` resume and `session_snapshot` fallback.', tags: ['sessions'],
    query: { after_event_id: { description: 'Resume cursor when the header is unavailable.' } },
    responses: { 200: { description: 'Event stream.', contentType: 'text/event-stream' }, 404: { description: 'Session not found.', contentType: 'application/json' } },
  },
  {
    method: 'GET', path: '/api/approval/stream', summary: 'Approval prompt stream (`initial` then `approval`).', tags: ['approval'],
    query: { session_id: { description: 'Session to follow.', required: true } },
    responses: { 200: { description: 'Event stream.', contentType: 'text/event-stream' } },
  },
  {
    method: 'GET', path: '/api/clarify/stream', summary: 'Clarify prompt stream (`initial` then `clarify`).', tags: ['approval'],
    query: { session_id: { description: 'Session to follow.', required: true } },
    responses: { 200: { description: 'Event stream.', contentType: 'text/event-stream' } },
  },
  {
    method: 'GET', path: '/api/file/raw', summary: 'Raw bytes of a workspace file or a session upload.', tags: ['files'],
    query: { session_id: { description: 'Session whose workspace anchors the path.', required: true }, path: { description: 'Workspace-relative path.', required: true }, download: { description: '`1` forces an attachment disposition.' }, inline: { description: '`1` serves HTML inline under a CSP sandbox.' } },
    responses: { 200: { description: 'File bytes with ETag and byte-range support.', contentType: 'application/octet-stream' }, 206: { description: 'Partial content for a satisfiable Range header.' }, 304: { description: 'ETag matched If-None-Match.' }, 404: { description: 'Path outside the workspace or missing.', contentType: 'application/json' }, 416: { description: 'Range not satisfiable.' } },
  },
  {
    method: 'GET', path: '/api/media', summary: 'Local media referenced by the chat (allow-listed roots, MEDIA: tokens, or an immutable snapshot).', tags: ['files'],
    query: { path: { description: 'Absolute local path.', required: true }, session_id: { description: 'Session whose assistant messages may grant the path.' }, inline: { description: '`1` allows inline audio, video, PDF, and sandboxed HTML.' }, snap: { description: 'SHA-256 digest of a message-level snapshot bound to the path.' } },
    responses: { 200: { description: 'Media bytes.', contentType: 'application/octet-stream' }, 206: { description: 'Partial content.' }, 304: { description: 'ETag matched.' }, 403: { description: 'Path not in an allowed location.', contentType: 'application/json' }, 404: { description: 'Not found.', contentType: 'application/json' }, 410: { description: 'Snapshot unavailable.', contentType: 'application/json' } },
  },
  {
    method: 'GET', path: '/api/folder/download', summary: 'ZIP of a workspace folder (symlinks escaping the workspace are skipped).', tags: ['files'],
    query: { session_id: { description: 'Session whose workspace anchors the path.', required: true }, path: { description: 'Workspace-relative folder.' } },
    responses: { 200: { description: 'ZIP stream.', contentType: 'application/zip' }, 404: { description: 'Folder missing.', contentType: 'application/json' }, 413: { description: 'Folder exceeds the configured size or file-count cap.', contentType: 'application/json' } },
  },
  {
    method: 'GET', path: '/api/session/export', summary: 'Transcript download as JSON or a self-contained HTML page.', tags: ['sessions'],
    query: { session_id: { description: 'Session to export.', required: true }, format: { description: '`json` (default) or `html`.' }, theme: { description: 'HTML only: `dark` (default) or `light`.' }, palette: { description: 'HTML only: base64 JSON map of CSS variables captured from the live UI.' } },
    responses: { 200: { description: 'Attachment named `hermes-<session_id>.<ext>`.' }, 404: { description: 'Session not found.', contentType: 'application/json' } },
  },
  {
    method: 'GET', path: '/api/kanban/events/stream', summary: 'Kanban task-event feed (SSE): `hello` then `events` batches with `id: <cursor>`; 15 s keepalive.', tags: ['automation'],
    query: { since: { description: 'Resume after this event id (else `Last-Event-ID`, else 0).' }, board: { description: 'Pin the stream to one board slug; omit to follow the active board.' } },
    responses: { 200: { description: 'Event stream.', contentType: 'text/event-stream' }, 400: { description: 'Invalid board slug.', contentType: 'application/json' }, 503: { description: 'Client stream limit reached.', contentType: 'application/json' } },
  },
  {
    method: 'GET', path: '/api/terminal/output', summary: 'Embedded terminal output (SSE): `output`, `terminal_closed`, `terminal_error` with integer ids and backlog replay from `Last-Event-ID`.', tags: ['automation'],
    query: { session_id: { description: 'Session whose terminal to attach.', required: true } },
    responses: { 200: { description: 'Event stream.', contentType: 'text/event-stream' }, 403: { description: 'Local-origin gate refused.', contentType: 'application/json' }, 404: { description: 'Terminal not running.', contentType: 'application/json' } },
  },
  {
    method: 'GET', path: '/extensions/{path}', summary: 'Static assets from the extension root (HTML answers with the panel sandbox CSP).', tags: ['automation'],
    responses: { 200: { description: 'Asset bytes.', contentType: 'application/octet-stream' }, 404: { description: 'Not found (never explains why).', contentType: 'application/json' } },
  },
  {
    method: 'POST', path: '/api/extensions/{id}/sidecar/{path}', summary: 'Consented loopback sidecar proxy (any method); headers stripped, 10 s, 512 KiB.', tags: ['automation'],
    responses: { 403: { description: 'Consent required or cross-origin request.', contentType: 'application/json' }, 409: { description: 'Sidecar unavailable.', contentType: 'application/json' }, 502: { description: 'Upstream failed or too large.', contentType: 'application/json' } },
  },
  {
    method: 'POST', path: '/api/transcribe', summary: 'Speech-to-text through the Agent (multipart `file`).', tags: ['tools'],
    requestBody: { contentType: 'multipart/form-data', description: 'Field `file` (audio).' },
    responses: { 200: { description: '`{ok, transcript}`.', contentType: 'application/json' }, 400: { description: 'No file or transcription failed.', contentType: 'application/json' }, 503: { description: 'Speech-to-text unavailable.', contentType: 'application/json' } },
  },
  {
    method: 'POST', path: '/api/tts', summary: 'Text-to-speech proxy (`engine`: openai or elevenlabs); answers `audio/mpeg`.', tags: ['tools'],
    requestBody: { contentType: 'application/json', description: '`{text, engine?, voice?, rate?, pitch?}`; `engine` defaults to the profile `tts.provider`.' },
    responses: { 200: { description: 'MP3 audio.', contentType: 'audio/mpeg' }, 400: { description: 'Invalid text, voice, or engine.', contentType: 'application/json' }, 429: { description: 'Rate limited (one request per 2 s per client).', contentType: 'application/json' }, 503: { description: 'Engine not configured; `code: tts_unconfigured` when no engine is named and no `tts.provider` is set.', contentType: 'application/json' } },
  },
  {
    method: 'POST', path: '/api/csp-report', summary: 'Browser CSP report sink (public, rate limited, always 204).', tags: ['tools'],
    requestBody: { contentType: 'application/json', description: 'CSP report payload.' },
    responses: { 204: { description: 'Accepted or dropped.', contentType: 'application/json' } },
  },
  {
    method: 'POST', path: '/api/process-complete-ack', summary: 'Retired: replaced by `/api/bg-task-complete-ack`. Always 410; CSRF exempt so a tab without a token learns the new path.', tags: ['chat'],
    responses: { 410: { description: '`{error, replaced_by}`.', contentType: 'application/json', headers: { 'X-Replaced-By': 'The replacement path, `/api/bg-task-complete-ack`.' } } },
  },
  {
    method: 'POST', path: '/api/upload', summary: 'Store one chat attachment in the session inbox and return a rollback receipt.', tags: ['files'],
    query: { session_id: { description: 'Target session (the multipart `session_id` field wins when present).' } },
    requestBody: { contentType: 'multipart/form-data', description: 'Fields `session_id` and `file`.' },
    responses: { 200: { description: 'Upload metadata.', contentType: 'application/json' }, 400: { description: 'No file or invalid name.', contentType: 'application/json' }, 409: { description: 'Destination already exists.', contentType: 'application/json' }, 413: { description: 'Body exceeds the upload cap.', contentType: 'application/json' } },
  },
  {
    method: 'POST', path: '/api/upload/extract', summary: 'Extract one archive (.zip, .tar, .tar.gz/.tgz, .tar.bz2/.tbz2, .tar.xz/.txz) into `<session inbox>/<stem>` and return a directory rollback receipt.', tags: ['files'],
    requestBody: { contentType: 'multipart/form-data', description: 'Fields `session_id` and `file`.' },
    responses: { 200: { description: '`{ok, extracted, files, dest, rollback_token}`.', contentType: 'application/json' }, 400: { description: 'No file, unsupported format, slip, member count over 10,000, or extracted bytes over `HERMES_WEBUI_MAX_EXTRACTED_MB`.', contentType: 'application/json' }, 404: { description: 'Unknown session or another profile\'s session.', contentType: 'application/json' }, 413: { description: 'Body exceeds the upload cap.', contentType: 'application/json' }, 500: { description: 'Unreadable archive or extraction failure.', contentType: 'application/json' } },
  },
  {
    method: 'POST', path: '/api/workspace/upload', summary: 'Store files in the session workspace under `path`; archives are extracted into `path/<stem>` and removed. One file answers its object, several answer `{files, count}`.', tags: ['files'],
    requestBody: { contentType: 'multipart/form-data', description: 'Field `session_id`, optional `path`, and one or more file parts.' },
    responses: { 200: { description: 'Per-file `{filename, path, size, mime, is_image, extracted}`; an archive adds `extracted_files`/`extracted_count`, or `extract_error` when extraction failed.', contentType: 'application/json' }, 400: { description: 'Missing `session_id`, no files, invalid path or name, too many duplicates, or a remote workspace (`code: remote_workspace_unsupported`).', contentType: 'application/json' }, 403: { description: 'Upload target escapes the workspace.', contentType: 'application/json' }, 404: { description: 'Unknown session, another profile\'s session, or an untrusted workspace.', contentType: 'application/json' }, 409: { description: 'Destination already exists or a Git operation is running.', contentType: 'application/json' }, 413: { description: 'Body exceeds the upload cap.', contentType: 'application/json' } },
  },
]
