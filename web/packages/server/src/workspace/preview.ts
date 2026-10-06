/**
 * `/api/file` previews (TAL-566): the server names how a workspace file renders, so clients only map the kind to an
 * element. Media files are only stat'ed; their bytes stream from `/api/file/raw`.
 */
import { extname } from 'node:path'
import type { FilePreviewKind } from '@maudecode/talaria-web-contracts'
import { hmacHex, safeEqual } from '../auth/crypto.js'
import { readFileContent, type FileContent } from './fs.js'
import { AUDIO_VIDEO_PDF_TYPES, INLINE_IMAGE_TYPES, mimeFor } from './media.js'

/** Rows a CSV preview ships, header included; the rest stay in the editable text. */
export const CSV_PREVIEW_ROWS = 500

const TEXT_KINDS: Record<string, FilePreviewKind> = { '.md': 'markdown', '.markdown': 'markdown', '.mdown': 'markdown', '.csv': 'csv', '.html': 'html', '.htm': 'html' }

export type FilePreview = FileContent & { preview: FilePreviewKind; mime?: string; table?: string[][]; table_truncated?: boolean; preview_url?: string }

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

/** Path prefix of the HTML preview frame's documents and their relative assets. */
export const PREVIEW_PREFIX = '/workspace-preview/'
const GRANT_HOURS_MS = 3600_000

/**
 * The HTML preview frame's URL: `workspace-preview/<grant>/<path>`, where the grant signs the workspace root with an
 * expiry 1 to 2 hours out (fixed within each hour, so a refetch keeps the same URL and the frame does not reload). The
 * sandboxed frame has an opaque origin and sends no cookie, so the grant, minted only after the caller could read
 * the file, is what authorizes the page and its relative assets.
 */
export function previewUrl(key: Buffer, root: string, rel: string, now = Date.now()): string {
  const exp = (Math.ceil(now / GRANT_HOURS_MS) + 1) * (GRANT_HOURS_MS / 1000)
  const grant = `${Buffer.from(root, 'utf8').toString('base64url')}.${String(exp)}`
  const path = rel.split('/').filter((part) => part && part !== '.').map(encodeURIComponent).join('/')
  return `${PREVIEW_PREFIX.slice(1)}${grant}.${hmacHex(key, `preview:${grant}`)}/${path}`
}

/** The workspace root a grant path segment authorizes, or null when it is forged or expired. */
export function previewGrantRoot(key: Buffer, segment: string, now = Date.now()): string | null {
  const parts = segment.split('.')
  if (parts.length !== 3) return null
  const [root, exp, sig] = parts as [string, string, string]
  if (!safeEqual(sig, hmacHex(key, `preview:${root}.${exp}`))) return null
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null
  return Buffer.from(root, 'base64url').toString('utf8')
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
