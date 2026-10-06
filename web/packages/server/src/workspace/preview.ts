/**
 * `/api/file` previews (TAL-566): the server names how a workspace file renders, so clients only map the kind to an
 * element. Media files are only stat'ed; their bytes stream from `/api/file/raw`.
 */
import { extname } from 'node:path'
import type { FilePreviewKind } from '@maudecode/talaria-web-contracts'
import { readFileContent, type FileContent } from './fs.js'
import { AUDIO_VIDEO_PDF_TYPES, INLINE_IMAGE_TYPES, mimeFor } from './media.js'

/** Rows a CSV preview ships, header included; the rest stay in the editable text. */
export const CSV_PREVIEW_ROWS = 500

const TEXT_KINDS: Record<string, FilePreviewKind> = { '.md': 'markdown', '.markdown': 'markdown', '.mdown': 'markdown', '.csv': 'csv', '.html': 'html', '.htm': 'html' }

export type FilePreview = FileContent & { preview: FilePreviewKind; mime?: string; table?: string[][]; table_truncated?: boolean }

function mediaKind(mime: string): FilePreviewKind | null {
  if (INLINE_IMAGE_TYPES.has(mime) || mime === 'image/svg+xml') return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (AUDIO_VIDEO_PDF_TYPES.has(mime)) return mime.startsWith('audio/') ? 'audio' : 'video'
  return null
}

export function readFilePreview(workspace: string, rel: string): FilePreview {
  const mime = mimeFor(rel)
  const media = mediaKind(mime)
  if (media) return { ...readFileContent(workspace, rel, { statOnly: true }), preview: media, mime }
  const file = readFileContent(workspace, rel)
  if (file.binary) return { ...file, preview: 'binary' }
  const preview = TEXT_KINDS[extname(rel).toLowerCase()] ?? 'text'
  if (preview !== 'csv') return { ...file, preview }
  const { rows, truncated } = csvRows(file.content ?? '', CSV_PREVIEW_ROWS)
  return { ...file, preview, table: rows, table_truncated: truncated }
}

/** RFC 4180 rows (quoted fields, doubled quotes, CRLF), skipping blank lines; stops after `limit` rows. */
export function csvRows(text: string, limit: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let truncated = false
  const endRow = () => {
    row.push(field)
    if (row.length > 1 || row[0] !== '') {
      if (rows.length === limit) truncated = true
      else rows.push(row)
    }
    row = []
    field = ''
  }
  for (let i = 0; i < text.length && !truncated; i++) {
    const c = text.charAt(i)
    if (quoted) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') { field += '"'; i++ }
      else quoted = false
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else field += c
  }
  if (!truncated && (field !== '' || row.length)) endRow()
  return { rows, truncated }
}
