/**
 * TAL-1968: `show` blocks. The agent shows the user a workspace file, a table, a chart or an HTML page; the server
 * validates the payload, stores one immutable document per block in the `show-blocks` namespace and serves it on
 * `/api/show/{block_id}`. An `html` block's page is served cookie-free from `/show-frame/<grant>` with a CSP that gives
 * it scripts and nothing else. Every refusal names its condition and stores nothing.
 *
 * TAL-1971: `deliver` stores a `file` block too, for a file of any type, with the digest of its bytes at delivery; each
 * read of the block says whether the live file still matches it.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { basename, isAbsolute, relative } from 'node:path'
import {
  SHOW_KINDS, SHOW_LIMITS, ShowBlockIdSchema,
  type DisplayMedia, type ShowBlock, type ShowKind, type SidecarServerParams, type SidecarServerResultInput,
} from '@maudecode/talaria-web-contracts'
import type { AppDeps } from '../http/context.js'
import type { DocumentBackend } from './storage/backend.js'
import { HttpFailure } from './service.js'
import { assetGrantValue, signAssetGrant } from '../auth/crypto.js'
import { FileTooLargeError, NotFoundError, PathTraversalError, openAnchoredFd, safeResolveWs } from '../workspace/fs.js'
import { resolvePathLikePython } from '../workspace/paths.js'
import { readFilePreview, type FilePreview } from '../workspace/preview.js'
import { mimeFor } from '../workspace/media.js'

const NAMESPACE = 'show-blocks'
/** Path prefix of the HTML frame's document. */
export const SHOW_FRAME_PREFIX = '/show-frame/'
/**
 * The frame's policy: scripts and styles inline, images, media and fonts from `data:` and `blob:` only, and no network
 * source at all, so the page cannot reach `/api` or anything else. `sandbox allow-scripts` gives it an opaque origin.
 */
export const SHOW_FRAME_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
const GRANT_NAMESPACE = 'show'

/** What `deliver` records: the file's type, and its size, mtime (ms) and SHA-256 at delivery. */
interface StoredDelivery { mime: string; size: number; mtime_ms: number; digest: string }
/**
 * A block as stored: the agent-independent fields, a `file` block's delivery record in place of its view (absent on a
 * `show` block), and an `html` block's body in place of its frame URL.
 */
type Stored = Exclude<ShowBlock, { kind: 'html' | 'file' }> & { profile: string }
  | Omit<Extract<ShowBlock, { kind: 'file' }>, 'delivery'> & { profile: string; delivery?: StoredDelivery }
  | Omit<Extract<ShowBlock, { kind: 'html' }>, 'frame_url' | 'expires_at'> & { profile: string; body: string }
type Fields<K extends ShowKind> = Omit<Extract<ShowBlock, { kind: K }>, 'block_id' | 'session_id' | 'title' | 'created_at' | 'kind' | 'delivery'>
/** The session `show` acts for: the caller's own. */
export interface ShowCaller { session_id: string; profile?: string | null; workspace?: string | null }

const refuse = (status: number, condition: string, message: string): HttpFailure => new HttpFailure(status, message, { code: condition })
const invalid = (message: string) => refuse(400, 'payload_invalid', message)
const notFound = (id: string) => refuse(404, 'show_unknown', `no show block ${id}`)

function text(value: unknown, field: string, required: boolean, limit: number = SHOW_LIMITS.title): string {
  if (value !== undefined && value !== null && typeof value !== 'string') throw invalid(`${field} must be a string`)
  const trimmed = (value ?? '').trim()
  if (required && !trimmed) throw invalid(`${field} is required`)
  if (trimmed.length > limit) throw invalid(`${field} is longer than ${limit} characters`)
  return trimmed
}

/** A table cell as text: strings as given, numbers and booleans as written, null as empty, anything else as JSON; capped. */
function cell(value: unknown): string {
  const shown = typeof value === 'string' ? value : value === null || value === undefined ? '' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
  return shown.length > SHOW_LIMITS.cell ? `${shown.slice(0, SHOW_LIMITS.cell - 1)}…` : shown
}

const tsvCell = (value: string): string => value.replace(/[\t\r\n]+/g, ' ')
const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
/** A value as the chart shows it: grouped digits, at most two decimals, and the unit (`%` attached, any other spaced). */
export const chartDisplay = (value: number, unit: string | null): string => `${NUMBER.format(value)}${!unit ? '' : unit === '%' ? '%' : ` ${unit}`}`

/** The SHA-256 of a workspace file's bytes, read through the anchored open. */
async function fileDigest(workspace: string, target: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(target, { fd: openAnchoredFd(workspace, target, { wantDir: false }) })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const rawUrl = (sessionId: string, path: string, flag: 'inline' | 'download'): string => `./api/file/raw?${new URLSearchParams({ session_id: sessionId, path, [flag]: '1' }).toString()}`

const TEXT_MIME: Partial<Record<string, string>> = { markdown: 'text/markdown', csv: 'text/csv' }

/** How a workspace file renders: a media row for an image, audio, video, PDF or 3D model, the companion page for text. */
function fileFields(sessionId: string, rel: string, preview: FilePreview | null): { mime: string; media: DisplayMedia | null; focus_path: string | null } {
  const name = basename(rel)
  const kind = preview?.preview
  const mapped = mimeFor(rel)
  // A file that decoded as text is text, whatever its extension's entry in the raw route's table says.
  const mime = preview?.mime ?? (mapped === 'application/octet-stream' && kind && kind !== 'binary' ? TEXT_MIME[kind] ?? 'text/plain' : mapped)
  const mediaKind = kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf' ? kind : mime.startsWith('model/') ? 'file' : null
  if (mediaKind) return { mime, media: { url: rawUrl(sessionId, rel, 'inline'), name, mime, kind: mediaKind }, focus_path: null }
  return { mime, media: null, focus_path: kind && kind !== 'binary' ? rel : null }
}

/** An `html` block's frame URL and when its grant expires (seconds), minted per request. */
export function showFrame(key: Buffer, blockId: string, now = Date.now()): { frame_url: string; expires_at: number } {
  const grant = signAssetGrant(key, GRANT_NAMESPACE, blockId, now)
  return { frame_url: `${SHOW_FRAME_PREFIX.slice(1)}${grant}`, expires_at: Number(grant.split('.')[1]) }
}

export class ShowBlocks {
  constructor(private readonly documents: DocumentBackend, private readonly deps: () => AppDeps, private readonly now: () => number) {}

  private profileName(profile: string | null | undefined): string {
    const name = profile || 'default'
    return this.deps().isRootProfile(name) ? 'default' : name
  }

  private async load(id: string): Promise<Stored | null> {
    if (!ShowBlockIdSchema.safeParse(id).success) return null
    try { return ((await this.documents.get(NAMESPACE, id))?.value as Stored | undefined) ?? null } catch { return null }
  }

  /**
   * The block as clients read it: a delivered file's record becomes its download URL and whether the file changed since,
   * and an `html` block's body a frame URL minted now.
   */
  private async view(stored: Stored): Promise<ShowBlock> {
    const { profile: _profile, ...block } = stored
    if (block.kind === 'file') {
      const { delivery, ...rest } = block
      return { ...rest, delivery: delivery ? { download_url: rawUrl(block.session_id, block.file.path, 'download'), mime: delivery.mime, changed: await this.changed(block.session_id, block.file.path, delivery) } : null }
    }
    if (block.kind !== 'html') return block
    const { body: _body, ...rest } = block
    return { ...rest, ...showFrame(this.deps().auth.signingKey(), block.block_id) }
  }

  /**
   * Whether the file the session's download serves differs from the delivered one: gone, another size, or (with a new
   * mtime) another digest. An unchanged size and mtime skip the hash.
   */
  private async changed(sessionId: string, rel: string, delivered: StoredDelivery): Promise<boolean> {
    try {
      const { workspace } = await this.deps().sessionStore.get(sessionId, { metadataOnly: true })
      const target = safeResolveWs(workspace, rel)
      const stat = statSync(target)
      if (!stat.isFile() || stat.size !== delivered.size) return true
      return stat.mtimeMs !== delivered.mtime_ms && (await fileDigest(workspace, target)) !== delivered.digest
    } catch {
      return true
    }
  }

  /** A deleted session takes its blocks with it. */
  async deleteForSession(sid: string): Promise<void> {
    for (const { key } of await this.documents.list(NAMESPACE)) {
      if ((await this.load(key))?.session_id === sid) await this.documents.delete(NAMESPACE, key)
    }
  }

  /** `show`: validate the payload for its kind and store the block. Nothing is stored on a refusal. */
  async put(caller: ShowCaller, params: Omit<SidecarServerParams<'server.show_put'>, 'caller_session_id'>): Promise<SidecarServerResultInput<'server.show_put'>> {
    if (!(SHOW_KINDS as readonly string[]).includes(params.kind)) throw refuse(400, 'kind_unknown', `kind must be one of ${SHOW_KINDS.join(', ')}`)
    const kind = params.kind as ShowKind
    const raw = params.payload
    const { title, fields, note } = kind === 'file' ? this.file(caller, raw) : kind === 'table' ? table(raw) : kind === 'chart' ? chart(raw) : html(raw)
    const id = await this.store(caller, kind, title, fields)
    return { block_id: id, url: `/session/${encodeURIComponent(caller.session_id)}`, kind, title, note }
  }

  private async store(caller: ShowCaller, kind: ShowKind, title: string, fields: object): Promise<string> {
    const newId = (): string => `sb_${randomBytes(6).toString('hex')}`
    let id = newId()
    while (await this.documents.get(NAMESPACE, id)) id = newId()
    const stored = { block_id: id, session_id: caller.session_id, profile: this.profileName(caller.profile), kind, title, created_at: this.now(), ...fields } as Stored
    await this.documents.put(NAMESPACE, id, stored, null)
    return id
  }

  /**
   * TAL-1971 `deliver`: a file block for a workspace file of any type up to `SHOW_LIMITS.deliver_bytes`, with the
   * file's digest recorded. A directory, a missing file and a path outside the workspace are refused, storing nothing.
   */
  async deliver(caller: ShowCaller, params: Omit<SidecarServerParams<'server.deliver'>, 'caller_session_id'>): Promise<SidecarServerResultInput<'server.deliver'>> {
    const path = text(params.path, 'path', true, 4096)
    const { workspace, rel, target } = this.workspaceFile(caller, path, 'outside_workspace')
    const missing = () => refuse(404, 'file_not_found', `${path} is not a file in this session's workspace`)
    let stat
    try { stat = statSync(target) } catch { throw missing() }
    if (stat.isDirectory()) throw refuse(400, 'is_directory', `${path} is a folder; deliver one file`)
    if (!stat.isFile()) throw missing()
    if (stat.size > SHOW_LIMITS.deliver_bytes) throw refuse(413, 'file_too_large', `${path} is ${stat.size} bytes; deliver hands over at most ${SHOW_LIMITS.deliver_bytes}`)
    let preview: FilePreview | null
    try { preview = readFilePreview(workspace, rel) } catch (error) {
      if (error instanceof NotFoundError || (error as NodeJS.ErrnoException).code === 'ENOENT') throw missing()
      if (!(error instanceof FileTooLargeError)) throw error
      preview = null // too long to preview as text: a download only
    }
    const name = basename(rel)
    const title = text(params.title, 'title', false) || name
    const { mime, media, focus_path } = fileFields(caller.session_id, rel, preview)
    const delivery: StoredDelivery = { mime, size: stat.size, mtime_ms: stat.mtimeMs, digest: await fileDigest(workspace, target).catch(() => { throw missing() }) }
    const id = await this.store(caller, 'file', title, { file: { path: rel, name, size: stat.size }, media, focus_path, delivery })
    return { block_id: id, url: `/session/${encodeURIComponent(caller.session_id)}`, kind: 'file', title, size: stat.size, media: media ?? { url: rawUrl(caller.session_id, rel, 'download'), name, mime, kind: 'file' } }
  }

  /** A path inside the caller's workspace by the `/api/file` rules (symlinks resolved), else `outside`. */
  private workspaceFile(caller: ShowCaller, path: string, outside: string): { workspace: string; rel: string; target: string } {
    const workspace = (caller.workspace ?? '').trim()
    if (!workspace) throw refuse(400, 'no_workspace', 'this session has no workspace')
    if (!this.deps().workspaces.profileSupportsLocalIo(caller.profile ?? null)) throw refuse(400, 'remote_workspace', 'this profile\'s workspace is not on this server')
    try {
      const target = safeResolveWs(workspace, path)
      const rel = relative(resolvePathLikePython(workspace), target)
      if (!rel || isAbsolute(rel)) throw new PathTraversalError(path)
      return { workspace, rel, target }
    } catch (error) {
      if (error instanceof PathTraversalError) throw refuse(400, outside, `${path} is outside this session's workspace`)
      throw error
    }
  }

  /** `file`: a file inside the session's workspace, by the `/api/file` rules; a media file ships as a media row. */
  private file(caller: ShowCaller, raw: Record<string, unknown>): { title: string; fields: Fields<'file'>; note: null } {
    const path = text(raw.path, 'path', true, 4096)
    const { workspace, rel } = this.workspaceFile(caller, path, 'path_outside_workspace')
    let preview: FilePreview
    try {
      preview = readFilePreview(workspace, rel)
    } catch (error) {
      if (error instanceof FileTooLargeError) throw refuse(400, 'file_too_large', error.message)
      if (error instanceof NotFoundError || (error as NodeJS.ErrnoException).code === 'ENOENT') throw refuse(404, 'file_not_found', `${path} is not a file in this session's workspace`)
      throw error
    }
    const name = basename(rel)
    const title = text(raw.title, 'title', false) || name
    const { media, focus_path } = fileFields(caller.session_id, rel, preview)
    if (!media && !focus_path) throw refuse(400, 'media_unsupported', `${name} is neither text nor an image, audio, video, PDF or 3D model`)
    return { title, fields: { file: { path: rel, name, size: preview.size }, media, focus_path }, note: null }
  }

  // ── routes ──────────────────────────────────────────────────────────────

  /** `GET /api/show/{id}`: a block of the request's profile in a session its person may see, else 404. */
  async get(id: string): Promise<ShowBlock> {
    const stored = await this.load(id)
    const deps = this.deps()
    if (!stored || !deps.profilesMatch(stored.profile, deps.activeProfile()) || !(await deps.sessions.personMaySeeSessionId(stored.session_id))) throw notFound(id)
    return await this.view(stored)
  }

  /** The HTML behind a frame grant, or null when the grant is forged or expired or its block is gone. */
  async frame(segment: string): Promise<string | null> {
    const id = assetGrantValue(this.deps().auth.signingKey(), GRANT_NAMESPACE, segment)
    const stored = id ? await this.load(id) : null
    return stored?.kind === 'html' ? stored.body : null
  }
}

/** `table`: header and rows as text, cut to the caps with the agent's counts kept. */
function table(raw: Record<string, unknown>): { title: string; fields: Fields<'table'>; note: string | null } {
  const title = text(raw.title, 'title', false) || 'Table'
  if (!Array.isArray(raw.columns) || raw.columns.length === 0) throw invalid('columns must be a non-empty list')
  if (!Array.isArray(raw.rows) || raw.rows.some((row) => !Array.isArray(row))) throw invalid('rows must be a list of lists')
  const allRows = raw.rows as unknown[][]
  const columns = raw.columns.slice(0, SHOW_LIMITS.columns).map(cell)
  const rows = allRows.slice(0, SHOW_LIMITS.rows).map((row) => columns.map((_, index) => cell(row[index])))
  const cut = raw.columns.length > columns.length || allRows.length > rows.length
  const truncation = cut ? { total_rows: allRows.length, total_columns: raw.columns.length } : null
  const tsv = [columns, ...rows].map((row) => row.map(tsvCell).join('\t')).join('\n')
  const note = cut ? `Showing ${rows.length} of ${allRows.length} rows and ${columns.length} of ${raw.columns.length} columns; a table shows at most ${SHOW_LIMITS.rows} rows and ${SHOW_LIMITS.columns} columns.` : null
  return { title, fields: { columns, rows, truncation, tsv }, note }
}

/** `chart`: bar or line series of labelled finite values, each formatted with the unit. */
function chart(raw: Record<string, unknown>): { title: string; fields: Fields<'chart'>; note: null } {
  const title = text(raw.title, 'title', true)
  const kind = raw.kind
  if (kind !== 'bar' && kind !== 'line') throw invalid('kind must be bar or line')
  const unit = text(raw.unit, 'unit', false, 16) || null
  if (!Array.isArray(raw.series) || raw.series.length === 0) throw invalid('series must be a non-empty list')
  if (raw.series.length > SHOW_LIMITS.series) throw invalid(`series has more than ${SHOW_LIMITS.series} entries`)
  const series = raw.series.map((entry: unknown, s) => {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    const name = text(item.name, `series[${s}].name`, false) || title
    if (!Array.isArray(item.points) || item.points.length === 0) throw invalid(`series[${s}].points must be a non-empty list`)
    if (item.points.length > SHOW_LIMITS.points) throw invalid(`series[${s}].points has more than ${SHOW_LIMITS.points} entries`)
    const labels = new Set<string>()
    const points = item.points.map((rawPoint: unknown, p) => {
      const point = rawPoint && typeof rawPoint === 'object' ? rawPoint as Record<string, unknown> : {}
      const label = text(point.label, `series[${s}].points[${p}].label`, true, 80)
      if (labels.has(label)) throw invalid(`series[${s}] repeats the label ${label}`)
      labels.add(label)
      if (typeof point.value !== 'number' || !Number.isFinite(point.value)) throw invalid(`series[${s}].points[${p}].value must be a finite number`)
      return { label, value: point.value, display: chartDisplay(point.value, unit) }
    })
    const peak = points.reduce((best, point) => (point.value > best.value ? point : best))
    return { name, points, max_display: chartDisplay(Math.max(0, ...points.map((point) => point.value)), unit), peak: { label: peak.label, display: peak.display } }
  })
  return { title, fields: { chart: kind, unit, series }, note: null }
}

/** `html`: a page body of at most `SHOW_LIMITS.html_bytes` UTF-8 bytes. */
function html(raw: Record<string, unknown>): { title: string; fields: { bytes: number; body: string }; note: null } {
  const title = text(raw.title, 'title', true)
  if (typeof raw.body !== 'string' || !raw.body.trim()) throw invalid('body is required')
  const bytes = Buffer.byteLength(raw.body, 'utf8')
  if (bytes > SHOW_LIMITS.html_bytes) throw refuse(413, 'html_too_large', `body is ${bytes} bytes; a page shows at most ${SHOW_LIMITS.html_bytes}`)
  return { title, fields: { bytes, body: raw.body }, note: null }
}
