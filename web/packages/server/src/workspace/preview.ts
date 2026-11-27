/**
 * `/api/file` previews (TAL-566): the server names how a workspace file renders, so clients only map the kind to an
 * element. Media files are only stat'ed; their bytes stream from `/api/file/raw`.
 */
import { basename, dirname, extname, relative, sep } from 'node:path'
import type { FilePreviewKind } from '@maudecode/talaria-web-contracts'
import { signAssetGrant, assetGrantValue } from '../auth/crypto.js'
import { readFileSnapshot, readFileContent, safeResolve, type FileContent } from './fs.js'
import { officeFormat, previewOffice, type OfficePreview } from './office.js'
import { AUDIO_VIDEO_PDF_TYPES, INLINE_IMAGE_TYPES, mimeFor } from './media.js'

/** Rows a CSV preview ships, header included; the rest stay in the editable text. */
export const CSV_PREVIEW_ROWS = 500

const TEXT_KINDS: Record<string, FilePreviewKind> = { '.md': 'markdown', '.markdown': 'markdown', '.mdown': 'markdown', '.csv': 'csv', '.html': 'html', '.htm': 'html' }

export type FilePreview = FileContent & Partial<Pick<OfficePreview, 'office_format' | 'editable' | 'edit_blocked_reason' | 'truncated'>> & { preview: FilePreviewKind; mime?: string; table?: string[][]; table_truncated?: boolean; preview_url?: string }

function mediaKind(mime: string): FilePreviewKind | null {
  if (INLINE_IMAGE_TYPES.has(mime) || mime === 'image/svg+xml') return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (AUDIO_VIDEO_PDF_TYPES.has(mime)) return mime.startsWith('audio/') ? 'audio' : 'video'
  return null
}

export function readFilePreview(workspace: string, rel: string, opts: { revision?: boolean } = {}): FilePreview {
  const mime = mimeFor(rel)
  const media = mediaKind(mime)
  if (media) return { ...readFileContent(workspace, rel, { statOnly: true }), preview: media, mime }
  // TAL-262: an Office file previews as its text; a hostile or unreadable archive throws `OfficeError`.
  if (officeFormat(rel)) {
    const { bytes, revision } = readFileSnapshot(workspace, rel)
    const office = previewOffice(rel, bytes)
    return { ...office, preview: 'office', ...(opts.revision && office.editable ? { revision } : {}) }
  }
  const file = readFileContent(workspace, rel, opts)
  if (file.binary) return { ...file, preview: 'binary' }
  const preview = TEXT_KINDS[extname(rel).toLowerCase()] ?? 'text'
  if (preview !== 'csv') return { ...file, preview }
  const { rows, truncated } = csvRows(file.content ?? '', CSV_PREVIEW_ROWS)
  return { ...file, preview, table: rows, table_truncated: truncated }
}

/** Path prefix of the HTML preview frame's documents and their relative assets. */
export const PREVIEW_PREFIX = '/workspace-preview/'

/**
 * The preview route's policy (TAL-2196): scripts, styles and assets from the page's own grant URL, inline or `data:`
 * and `blob:`, no fetch, XHR, WebSocket or form target, no `<base>`, and popups that stay sandboxed.
 */
export const PREVIEW_CSP = "sandbox allow-scripts allow-popups; default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"

/**
 * The HTML preview frame's URL: `workspace-preview/<grant>/<basename>`, where the grant signs the folder holding the
 * file, resolved inside the workspace, with an expiry 1 to 2 hours out (fixed within each hour, so a refetch keeps the
 * same URL and the frame does not reload). The sandboxed frame has an opaque origin and sends no cookie, so the grant,
 * minted only after the caller could read the file, is what authorizes the page and its relative assets in that folder
 * and below; `../` assets and dot-prefixed paths do not load. The page's CSP denies network calls, but it can still
 * navigate itself to another URL carrying its own address; that leak is accepted because the address unlocks only this
 * folder, minus dotfiles, until the grant expires.
 */
export function previewUrl(key: Buffer, root: string, rel: string, now = Date.now()): string {
  const target = safeResolve(root, rel)
  return `${PREVIEW_PREFIX.slice(1)}${signAssetGrant(key, 'preview', dirname(target), now)}/${encodeURIComponent(basename(target))}`
}

/** The folder a grant path segment authorizes, or null when it is forged or expired. */
export function previewGrantRoot(key: Buffer, segment: string, now = Date.now()): string | null {
  return assetGrantValue(key, 'preview', segment, now)
}

/** The file `rel` names under a grant's folder, or null when it escapes the folder or has a dot-prefixed segment. */
export function previewTarget(dir: string, rel: string): string | null {
  try {
    const target = safeResolve(dir, rel)
    return relative(dir, target).split(sep).some((part) => part.startsWith('.')) ? null : target
  } catch {
    return null
  }
}

const REPORT_THEME_KEYS = ['--background', '--foreground', '--card', '--muted', '--muted-foreground', '--border', '--primary', '--primary-foreground', '--font-sans', '--font-mono'] as const
const REPORT_COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgb[a]?|hsl[a]?|oklch|oklab|color)\([a-z0-9.,%+ /-]+\))$/i
const REPORT_FONT = /^[a-z0-9 "'_,.-]+$/i

/** Accept CSS values only, with neither HTML delimiters nor URL, declaration or escape syntax. */
export function reportThemeTag(raw: string | null): string {
  if (!raw || raw.length > 2048) return ''
  let values: unknown
  try { values = JSON.parse(raw) } catch { return '' }
  if (!values || typeof values !== 'object' || Array.isArray(values)) return ''
  const declarations = REPORT_THEME_KEYS.flatMap((name) => {
    const value = (values as Record<string, unknown>)[name]
    const pattern = name.startsWith('--font-') ? REPORT_FONT : REPORT_COLOR
    return typeof value === 'string' && value.length <= 160 && pattern.test(value) ? [`${name}:${value};`] : []
  })
  if (declarations.length === 0) return ''
  return `<style>:where(:root){${declarations.join('')}}</style>`
}

/** The outer frame owns navigation. Keep same-page fragments local and let standalone reports use native links. */
export const REPORT_LINK_BRIDGE = `<script>
if (parent !== window) {
  const route = (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = anchor?.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    if (!event.isTrusted) return;
    if (href.startsWith('#')) { location.hash = href; return; }
    parent.postMessage({type:'talaria-report-link', url:anchor.href}, location.origin);
  };
  addEventListener('click', route, true);
  addEventListener('auxclick', route, true);
}
</script>`

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
