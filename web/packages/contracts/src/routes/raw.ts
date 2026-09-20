/**
 * Byte-stream routes the server implements outside oRPC (file bodies, ZIP
 * streams, multipart uploads, downloads). They are documented here so the
 * generated OpenAPI document covers every HTTP path a consumer may call.
 */
import { z } from 'zod'

export const UploadResponseSchema = z.object({ filename: z.string(), path: z.string(), size: z.number().int(), mime: z.string(), is_image: z.boolean(), rollback_token: z.string() })

export interface RawRoute {
  method: 'GET' | 'POST'
  path: string
  summary: string
  tags: string[]
  query?: Record<string, { description: string; required?: boolean }>
  requestBody?: { contentType: string; description: string }
  responses: Record<number, { description: string; contentType?: string }>
}

export const RAW_ROUTES: readonly RawRoute[] = [
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
    method: 'POST', path: '/api/upload', summary: 'Store one chat attachment in the session inbox and return a rollback receipt.', tags: ['files'],
    query: { session_id: { description: 'Target session (the multipart `session_id` field wins when present).' } },
    requestBody: { contentType: 'multipart/form-data', description: 'Fields `session_id` and `file`.' },
    responses: { 200: { description: 'Upload metadata.', contentType: 'application/json' }, 400: { description: 'No file or invalid name.', contentType: 'application/json' }, 409: { description: 'Destination already exists.', contentType: 'application/json' }, 413: { description: 'Body exceeds the upload cap.', contentType: 'application/json' } },
  },
]
