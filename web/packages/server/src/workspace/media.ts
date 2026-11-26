/**
 * Byte-serving helpers and the `/api/media` allow/deny model (Python
 * `_serve_file_bytes`, `_media_deny_reason`, and `_session_media_token_allows_path`).
 */
import { closeSync, createReadStream, fstatSync, lstatSync, openSync, readdirSync, read, realpathSync, statSync } from 'node:fs'
import { constants as fsConstants, type BigIntStats } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { settledFileStatKey } from '../fs/stat.js'
import type { RequestContext } from '../http/context.js'
import { NotFoundError, openAnchoredFd } from './fs.js'
import { isWithin, resolvePathLikePython } from './paths.js'
import { str } from '../util.js'
import type { Session } from '../sessions/session.js'
import { TOOL_PRESENTATIONS } from '@maudecode/talaria-web-contracts'
import { toolName } from '../sessions/tool-display.js'

export const MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.ts': 'text/plain', '.tsx': 'text/plain',
  // An HTML preview's stylesheets and scripts: with `nosniff`, a browser applies or runs them only under these types.
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
}

export function mimeFor(path: string): string {
  return MIME_MAP[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/x-icon', 'image/bmp'])
export const AUDIO_VIDEO_PDF_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/flac', 'video/mp4', 'video/quicktime', 'video/webm', 'video/ogg', 'application/pdf'])
export const SESSION_MEDIA_TOKEN_TYPES = new Set([...INLINE_IMAGE_TYPES, ...AUDIO_VIDEO_PDF_TYPES, 'text/html'])
const HTML_PREVIEW_BUFFER_CAP = 10 * 1024 * 1024
export const PREVIEW_PERMISSIONS_POLICY = 'camera=(), microphone=(self), geolocation=(), clipboard-write=(self)'

/** Latin-1-safe Content-Disposition with an RFC 5987 `filename*`. */
export function contentDispositionValue(disposition: string, filename: string): string {
  const safeName = basename(filename).replace(/\r/g, '').replace(/\n/g, '')
  const asciiOf = (s: string): string => Array.from(s, (ch) => { const c = ch.charCodeAt(0); return c >= 32 && c < 127 && ch !== '"' && ch !== '\\' ? ch : '_' }).join('')
  let fallback = asciiOf(safeName).replace(/^[ .]+|[ .]+$/g, '')
  if (!fallback) {
    const suffix = asciiOf(extname(safeName))
    fallback = suffix ? `download${suffix}` : 'download'
  }
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safeName).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

export function parseRangeHeader(header: string | undefined, fileSize: number): [number, number] | null {
  if (!header?.startsWith('bytes=') || fileSize < 1) return null
  const spec = header.slice('bytes='.length).trim()
  if (spec.includes(',') || !spec.includes('-')) return null
  const dash = spec.indexOf('-')
  const startS = spec.slice(0, dash)
  const endS = spec.slice(dash + 1)
  const int = (s: string): number | null => (/^\d+$/.test(s) ? Number.parseInt(s, 10) : null)
  let start: number
  let end: number
  if (startS === '') {
    const suffix = int(endS)
    if (suffix === null || suffix <= 0) return null
    start = Math.max(0, fileSize - suffix)
    end = fileSize - 1
  } else {
    const s = int(startS)
    if (s === null) return null
    start = s
    if (endS) {
      const e = int(endS)
      if (e === null) return null
      end = Math.min(e, fileSize - 1)
    } else end = fileSize - 1
  }
  if (start > end || start >= fileSize) return null
  return [start, end]
}

/** RFC 7232 §3.2 weak comparison. */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (!header || !etag) return false
  if (header.trim() === '*') return true
  const strip = (v: string): string => (v.startsWith('W/') ? v.slice(2) : v)
  const current = strip(etag)
  return header.split(',').map((c) => c.trim()).filter(Boolean).some((c) => strip(c) === current)
}

export async function readAll(fd: number, size: number, start = 0): Promise<Buffer> {
  const chunks: Buffer[] = []
  let remaining = size
  const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, size)))
  let position = start
  while (remaining > 0) {
    const n = await new Promise<number>((resolve, reject) => {
      read(fd, buf, 0, Math.min(buf.length, remaining), position, (error, bytesRead) => {
        if (error) reject(error)
        else resolve(bytesRead)
      })
    })
    if (n <= 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
    remaining -= n
    position += n
  }
  return Buffer.concat(chunks)
}

/** Weak validator from the opened descriptor's identity: any rewrite, truncation or replacement changes it. */
function signatureValidator(st: BigIntStats): string {
  return `W/"${String(st.ino)}-${String(st.size)}-${String(st.mtimeNs)}-${String(st.ctimeNs)}"`
}

export interface ServeFileOptions {
  mime: string
  disposition: string
  cacheControl: string
  csp?: string | null
  anchorRoot?: string | null
  downloadName?: string | null
  /** Media policy on the opened inode: a file with more than one link may be a hard link to a denied state file. */
  denyHardLinks?: boolean
  /** A content check on the opened inode before any byte is sent: a reason refuses it with 403. */
  inspect?: (fd: number, size: number) => string | null
}

/** Serve a file with MIME/disposition, weak ETag revalidation, and single byte ranges. */
export async function serveFileBytes(ctx: RequestContext, target: string, opts: ServeFileOptions): Promise<void> {
  let fd: number | null = null
  let fileSize: number
  let etag: string | null
  try {
    fd = opts.anchorRoot ? openAnchoredFd(opts.anchorRoot, resolvePathLikePython(target), { wantDir: false }) : openSync(target, fsConstants.O_RDONLY)
    const st = fstatSync(fd, { bigint: true })
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' })
    if (opts.denyHardLinks && st.nlink > 1n) { closeSync(fd); fd = null; (await ctx.json({ error: 'Path not in allowed location' }, { status: 403 })); return }
    fileSize = Number(st.size)
    etag = opts.cacheControl.includes('no-store') ? null : signatureValidator(st)
    const refusal = opts.inspect?.(fd, fileSize)
    if (refusal) { closeSync(fd); fd = null; (await ctx.json({ error: refusal }, { status: 403 })); return }
  } catch (error) {
    if (fd !== null) closeSync(fd)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') { (await ctx.json({ error: 'Permission denied' }, { status: 403 })); return }
    if (error instanceof NotFoundError || code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP') { (await ctx.json({ error: 'not found' }, { status: 404 })); return }
    if (error instanceof Error && !code) { (await ctx.json({ error: sanitizeError(error) }, { status: 403 })); return }
    await ctx.json({ error: 'Could not stat file' }, { status: 500 })
    return
  }
  try {
    const rangeHeader = ctx.header('range')
    const baseHeaders: Record<string, string> = { 'Cache-Control': opts.cacheControl }
    if (etag && ifNoneMatchMatches(ctx.header('if-none-match'), etag)) {
      await ctx.send({ status: 304, headers: { ...baseHeaders, ETag: etag } })
      return
    }
    const byteRange = parseRangeHeader(rangeHeader, fileSize)
    if (rangeHeader && !byteRange) {
      await ctx.send({ status: 416, headers: { 'Content-Range': `bytes */${String(fileSize)}`, 'Accept-Ranges': 'bytes' } })
      return
    }
    const [start, end] = byteRange ?? [0, Math.max(0, fileSize - 1)]
    const contentLength = fileSize ? end - start + 1 : 0
    const headers: Record<string, string> = {
      ...baseHeaders,
      'Content-Type': opts.mime,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': contentDispositionValue(opts.disposition, opts.downloadName ?? basename(target)),
    }
    if (etag) headers.ETag = etag
    if (byteRange) headers['Content-Range'] = `bytes ${String(start)}-${String(end)}/${String(fileSize)}`
    if (opts.csp) Object.assign(headers, previewHeaders(opts.csp))
    if (!contentLength) {
      await ctx.send({ status: byteRange ? 206 : 200, headers, body: Buffer.alloc(0), security: !opts.csp })
      return
    }
    // Every body streams the selected span from the descriptor with backpressure (Python copied bounded chunks); the
    // stream owns the descriptor from here.
    const stream = createReadStream('', { fd, start, end: start + contentLength - 1, autoClose: true, highWaterMark: 256 * 1024 })
    fd = -1
    try {
      await ctx.sendStream({ status: byteRange ? 206 : 200, headers: { ...headers, 'Content-Length': String(contentLength) }, security: !opts.csp }, stream)
    } catch (error) {
      stream.destroy()
      throw error
    }
  } finally {
    if (fd !== -1) closeSync(fd)
  }
}

/**
 * Sandboxed inline HTML keeps framing allowed (no X-Frame-Options) but pins CSP. It sends no referrer, so a page's
 * `<meta name=referrer>` cannot widen what leaves with its own address (TAL-2196).
 */
export function previewHeaders(csp: string): Record<string, string> {
  return { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': PREVIEW_PERMISSIONS_POLICY }
}

function htmlPreviewWithBlankBase(raw: Buffer, headTags: string): Buffer {
  return htmlWithHeadTag(raw, `<base target="_blank">${headTags}`)
}

/** Insert `base` as the first `<head>` child, creating the head after any doctype so the page keeps standards mode. */
export function htmlWithHeadTag(raw: Buffer, base: string): Buffer {
  let text = raw.toString('utf8')
  if (/<head(?:\s[^>]*)?>/i.test(text)) text = text.replace(/<head\b[^>]*>/i, (head) => head + base)
  else if (/<!doctype[^>]*>/i.test(text)) text = text.replace(/<!doctype[^>]*>/i, (doctype) => `${doctype}<head>${base}</head>`)
  else text = `<head>${base}</head>${text}`
  return Buffer.from(text, 'utf8')
}

export async function serveInlineHtmlPreview(ctx: RequestContext, target: string, cacheControl: string, csp: string, anchorRoot: string | null, headTags = ''): Promise<void> {
  let body: Buffer | null = null
  try {
    const fd = anchorRoot ? openAnchoredFd(anchorRoot, resolvePathLikePython(target), { wantDir: false }) : openSync(target, fsConstants.O_RDONLY)
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' })
      // The preview is rewritten in memory; anything past the buffering cap is served as a download instead.
      if (st.size <= HTML_PREVIEW_BUFFER_CAP) body = htmlPreviewWithBlankBase(await readAll(fd, st.size), headTags)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') { (await ctx.json({ error: 'Permission denied' }, { status: 403 })); return }
    if (error instanceof NotFoundError || code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP') { (await ctx.json({ error: 'not found' }, { status: 404 })); return }
    if (error instanceof Error && !code) { (await ctx.json({ error: sanitizeError(error) }, { status: 403 })); return }
    await ctx.json({ error: 'Could not read file' }, { status: 500 })
    return
  }
  if (!body) {
    await serveFileBytes(ctx, target, { mime: 'text/html', disposition: 'attachment', cacheControl, anchorRoot })
    return
  }
  await ctx.send({
    status: 200,
    security: false,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Accept-Ranges': 'none', 'Cache-Control': cacheControl, 'Content-Disposition': contentDispositionValue('inline', basename(target)), ...previewHeaders(csp) },
    body,
  })
}

export function sanitizeError(error: unknown): string {
  return str((error as Error).message ?? error).replace(/(?:(?:\/[a-zA-Z0-9_.-]+)+|(?:[A-Z]:\\[^\s]+))/g, '<path>')
}

// ── allow / deny model ───────────────────────────────────────────────────────

const MEDIA_TOKEN_RE = /MEDIA:([^\s)\]]+)/g

function messageContentText(content: unknown): string {
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' ? str((part as { text?: unknown }).text) : str(part))).join('\n')
  return str(content)
}

/** A `MEDIA:` path as the session-token grant reads it: `~` is the user's home, a relative path is the server's cwd. */
export function mediaRefPath(ref: string): string {
  return resolvePathLikePython(ref.replace(/^~(?=$|\/)/, process.env.HOME ?? ''))
}

/** TAL-2325: the Agent tools whose results name the media they made (`TOOL_PRESENTATIONS` presentation `media`). */
const MEDIA_TOOLS = new Set(Object.entries(TOOL_PRESENTATIONS).flatMap(([name, entry]) => (entry.presentation === 'media' ? [name] : [])))
const isMediaTool = (name: string): boolean => MEDIA_TOOLS.has(name)
/** TAL-2328: the Agent tools whose results name a screenshot they saved. */
const SCREENSHOT_TOOLS = new Set(['browser_exec', 'computer_use'])

/**
 * TAL-2328: where a `computer_use` capture summary says it saved its screenshot: its own note line
 * (`  (shareable screenshot saved to /p.png)`), never an element line (`  #1 …`), whose label is on-screen text.
 */
const SCREENSHOT_SAVED_RE = /^ {2}\(shareable screenshot saved to (.+)\)$/m

/**
 * TAL-2328: the screenshot a browser or computer-use result saved, as written: its `screenshot_path`, a multimodal
 * envelope's under `meta` (an object, or the JSON text the sidecar forwards it as), else the path its capture summary
 * names, in a JSON result's text or a multimodal one's `text_summary`. Empty for a failed call or none.
 */
export function screenshotRefs(result: unknown): string[] {
  // A native-vision result's text part is its JSON line, then a note that the screenshot is attached.
  const data = typeof result === 'string' ? jsonObject(result) ?? jsonObject(result.split('\n', 1)[0]!) : result
  if (typeof result === 'string' && !data) return [SCREENSHOT_SAVED_RE.exec(result)?.[1]?.trim() ?? ''].filter(Boolean)
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const record = data as Record<string, unknown>
  if (record.success === false || record.ok === false || record.error) return []
  let meta = record.meta
  if (typeof meta === 'string') try { meta = JSON.parse(meta) } catch { meta = undefined }
  const metaPath = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>).screenshot_path : undefined
  const refs = [...refList(record.screenshot_path), ...refList(metaPath), ...[str(record.summary), str(record.text_summary)].flatMap((text) => SCREENSHOT_SAVED_RE.exec(text)?.[1]?.trim() ?? [])]
  return [...new Set(refs)].filter((ref) => !/^data:/i.test(ref))
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.trimStart().startsWith('{')) return undefined
  try {
    const data: unknown = JSON.parse(text)
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** TAL-2325/TAL-2328: the local files and URLs a media or screenshot tool's result names; nothing for any other tool. */
function toolResultRefs(name: string, result: unknown): string[] {
  if (SCREENSHOT_TOOLS.has(name)) return screenshotRefs(Array.isArray(result) ? messageContentText(result) : result)
  if (!isMediaTool(name)) return []
  const data = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : resultObject(result)
  return data ? mediaResultRefs(data) : []
}

/** A result field's references: a list, the JSON text of one (the sidecar sends a nested value as text), or one string; an object item names its `url`, `image` or `path`. */
function refList(value: unknown): string[] {
  let items = value
  if (typeof value === 'string' && value.trimStart().startsWith('[')) try { items = JSON.parse(value) } catch { /* one path that starts with `[` */ }
  return (Array.isArray(items) ? items : [items])
    .map((item) => (item && typeof item === 'object' ? str((item as Record<string, unknown>).url ?? (item as Record<string, unknown>).image ?? (item as Record<string, unknown>).path) : typeof item === 'string' ? item : '').trim())
    .filter(Boolean)
}

/**
 * TAL-2325: what a media tool's result made, as written, in order and once each: `image_generate`'s `image` and
 * `additional_images`, `text_to_speech`'s `file_paths` (else `file_path`), a video tool's `video` (else its `public_url`).
 * A `data:` URL is never a reference. Empty for a failed call.
 */
export function mediaResultRefs(data: Record<string, unknown>): string[] {
  if (data.success === false || data.error) return []
  const video = refList(data.video)
  const refs = [...refList(data.image), ...refList(data.additional_images), ...refList(data.file_paths), ...refList(data.file_path), ...(video.length ? video : refList(data.public_url))]
  return [...new Set(refs)].filter((ref) => !/^data:/i.test(ref))
}

/** TAL-2325: the local files each session's running media tools made, by session id, newest last. */
const liveMediaGrants = new Map<string, Set<string>>()
// ponytail: in memory and capped by session; a restart drops a live grant, after which the settled rows grant their files.
const LIVE_MEDIA_SESSIONS = 256

/**
 * TAL-2325: grant the local files a running turn's media tool made, before its completion frame ships their URLs: its rows
 * reach the transcript, which the session scan reads, only when the turn settles. Kept after settlement too, since a failed
 * or cancelled turn's snapshot keeps the URLs its rows never grant. Nothing for any other tool or a failed call.
 */
export function grantLiveMedia(sessionId: string, name: unknown, data: unknown): void {
  if (!sessionId || typeof name !== 'string') return
  const refs = toolResultRefs(name, data).filter((ref) => !ref.includes('://'))
  if (!refs.length) return
  const granted = liveMediaGrants.get(sessionId) ?? new Set<string>()
  liveMediaGrants.delete(sessionId)
  for (const ref of refs) granted.add(ref)
  liveMediaGrants.set(sessionId, granted)
  if (liveMediaGrants.size > LIVE_MEDIA_SESSIONS) liveMediaGrants.delete(liveMediaGrants.keys().next().value!)
}

/** A tool row's result as an object, from its JSON text; null for any other result. */
function resultObject(content: unknown): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(messageContentText(content))
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The ids and names of the media (TAL-2328: and screenshot) tool calls an assistant row made, from its `tool_calls` and `tool_use` blocks (`content`). */
function mediaCalls(message: Record<string, unknown>, content: unknown): [string, string][] {
  const calls = [...(Array.isArray(message.tool_calls) ? message.tool_calls as unknown[] : []), ...(Array.isArray(content) ? content as unknown[] : [])]
  return calls.flatMap((call): [string, string][] => {
    if (!call || typeof call !== 'object') return []
    const name = toolName(call as Record<string, unknown>)
    const id = str((call as Record<string, unknown>).id)
    return id && (isMediaTool(name) || SCREENSHOT_TOOLS.has(name)) ? [[id, name]] : []
  })
}

/** The `MEDIA:` references the assistant and tools wrote in these rows, as written, and (TAL-2325) the local files a media tool's result made. */
function scanMediaRefs(rows: Session['messages']): Set<string> {
  const refs = new Set<string>()
  const calls = new Map<string, string>()
  for (const message of rows) {
    if (!message || typeof message !== 'object') continue
    const role = str((message as { role?: unknown }).role).trim().toLowerCase()
    if (role === 'user') continue
    // Read once: a row's content may be a large transcript part.
    const content = (message as { content?: unknown }).content
    if (role === 'assistant') for (const [id, name] of mediaCalls(message, content)) calls.set(id, name)
    const call = role === 'tool' ? calls.get(str((message as { tool_call_id?: unknown }).tool_call_id)) : undefined
    if (call) for (const ref of toolResultRefs(call, content)) if (!ref.includes('://')) refs.add(ref)
    const text = messageContentText(content)
    if (!text.includes('MEDIA:')) continue
    for (const m of text.matchAll(MEDIA_TOKEN_RE)) {
      const ref = m[1] ?? ''
      if (ref.includes('://')) continue
      refs.add(ref)
      // TAL-2029: `` `MEDIA:/path`. `` grants the path inside the code span, whatever follows it.
      const tick = ref.indexOf('`')
      if (tick > 0) refs.add(ref.slice(0, tick))
    }
  }
  return refs
}

interface SessionMediaRefs { rows: Session['messages']; length: number; revision: string | null; refs: Set<string>; resolved: Set<string> | null }

const scannedMediaRefs = new WeakMap<Session, SessionMediaRefs>()

/**
 * A session's references, scanned once for its saved revision. A row a running turn appended grows the scan; a session
 * that has no revision yet is never kept.
 */
function sessionMediaRefs(session: Session): SessionMediaRefs {
  const rows = session.messages
  const revision = session.sidecarLoadedSignature
  const scanned = scannedMediaRefs.get(session)
  if (scanned?.rows === rows && scanned.length === rows.length && scanned.revision === revision) return scanned
  const fresh: SessionMediaRefs = { rows, length: rows.length, revision, refs: scanMediaRefs(rows), resolved: null }
  if (revision) scannedMediaRefs.set(session, fresh)
  return fresh
}

/**
 * Allow exact safe `MEDIA:` paths the assistant/tool emitted in the requested session. The transcript is read at most
 * once per grant, and its references resolved at most once: a reference written as the target's own path needs neither.
 */
function sessionMediaGrant(session: Session | null): (target: string, real: string) => boolean {
  let scanned: SessionMediaRefs | null = null
  return (target, real) => {
    if (!session) return false
    const live = liveMediaGrants.get(str(session.session_id))
    if (live && (live.has(target) || Array.from(live, (ref) => mediaRefPath(ref)).includes(real))) return true
    scanned ??= sessionMediaRefs(session)
    if (scanned.refs.has(target)) return true
    // ponytail: a symlink retargeted after this resolve keeps its earlier answer until the next save; re-resolve on a miss if that ever bites.
    scanned.resolved ??= new Set(Array.from(scanned.refs, (ref) => mediaRefPath(ref)))
    return scanned.resolved.has(real)
  }
}

export function safePlatformTempRoot(protectedRoots: string[]): string | null {
  try {
    const candidate = realpathSync(tmpdir())
    const protectedResolved = protectedRoots.map((r) => { try { return realpathSync(r) } catch { return resolvePathLikePython(r) } })
    if (!statSync(candidate).isDirectory() || candidate === '/') return null
    if (process.platform === 'win32') return null
    if (protectedResolved.some((root) => candidate === root || isWithin(candidate, root) || isWithin(root, candidate))) return null
    const st = statSync(candidate)
    if (st.uid !== userInfo().uid) return null
    if (st.mode & 0o077) return null
    return candidate
  } catch {
    return null
  }
}

export function safeLegacyTmpRoot(protectedRoots: string[]): string | null {
  try {
    const candidate = realpathSync('/tmp')
    const protectedResolved = protectedRoots.map((r) => { try { return realpathSync(r) } catch { return resolvePathLikePython(r) } })
    if (protectedResolved.some((root) => root === candidate || isWithin(root, candidate))) return null
    return candidate
  } catch {
    return null
  }
}

export interface MediaPolicyDeps<T = string | null | Promise<string | null>> {
  home: string
  hermesHome: string
  stateDir: string
  /** `TALARIA_WEB_MEDIA_SNAPSHOT_DIR` from the Python server: its leftover snapshot copies stay internal. */
  legacySnapshotDir?: string | undefined
  /** The active workspace when local IO is supported, else null. */
  activeWorkspace: () => T
}

const DENY_FILENAMES = new Set(['settings.json', 'state.db', 'state.db-wal', 'state.db-shm', 'state.db-journal', 'kanban.db', 'kanban.db-wal', 'kanban.db-shm', 'kanban.db-journal', 'auth.json', 'auth.lock', 'config.yaml', 'config.yml', '.env', '.signing_key', '.pbkdf2_key', '.sessions.json', 'google_token.json', 'google_client_secret.json', 'google_oauth.json', 'google_oauth_pending.json', '.anthropic_oauth.json', 'webhook_subscriptions.json', 'gateway_state.json', 'channel_directory.json', 'jobs.json', 'passkeys.json', '.passkey_challenges.json', '.login_attempts.json', 'bws_cache.json', 'bws_cache.enc.json', 'op_cache.json', 'photon-sidecar.json'])
// `credentials` may be a file or a directory; the check below covers the path itself and anything inside it.
const DENY_SUBDIRS = ['sessions', 'memories', 'cron', 'logs', 'checkpoints', 'backups', 'media_snapshots', 'credentials', 'pairing', 'mcp-tokens', 'webapp', 'browser-profile']
const DENY_TMP_SUFFIXES = ['.sessions.tmp', '.login_attempts.tmp', '.passkeys.tmp', '.passkey_challenges.tmp']

/** `p` with its symlinks resolved and a missing tail kept lexically. */
function realOrResolved(p: string): string {
  try { return realpathSync(p) } catch { return resolvePathLikePython(p) }
}
const norm = (p: string): string => realOrResolved(p).toLowerCase()

/** The normalized comparison lists of one set of homes, and every directory whose entries could change them. */
interface MediaPolicyScope { roots: string[]; denyDirs: string[]; watched: string[] }

function buildMediaPolicyScope(deps: Pick<MediaPolicyDeps, 'home' | 'hermesHome' | 'stateDir'>): MediaPolicyScope {
  const baseRoots = [deps.hermesHome, join(deps.home, '.hermes'), deps.stateDir]
  const watched = new Set(baseRoots)
  /** A child of a real directory is real unless it is itself a symlink, the one case that needs a resolve (and a watch: a retarget further along the chain leaves its parent untouched). */
  const realChild = (parent: string, name: string): string => {
    const child = join(parent, name)
    try { if (!lstatSync(child).isSymbolicLink()) return child } catch { return child }
    watched.add(child)
    return realOrResolved(child)
  }
  const roots = new Map<string, string>()
  const addRoot = (real: string): void => { if (!roots.has(real.toLowerCase())) roots.set(real.toLowerCase(), real) }
  for (const root of baseRoots) addRoot(realOrResolved(root))
  for (const root of [...roots.values()]) {
    watched.add(join(root, 'profiles'))
    const profilesDir = realChild(root, 'profiles')
    try {
      for (const child of readdirSync(profilesDir, { withFileTypes: true })) if (child.isDirectory()) addRoot(join(profilesDir, child.name))
    } catch { /* no profiles dir */ }
  }
  const denyDirs: string[] = []
  for (const root of roots.values()) {
    watched.add(root).add(join(root, 'webui_state'))
    const state = realChild(root, 'webui_state')
    for (const sub of DENY_SUBDIRS) denyDirs.push(realChild(root, sub).toLowerCase(), realChild(state, sub).toLowerCase())
  }
  return { roots: [...roots.keys()], denyDirs, watched: [...watched] }
}

/** The stat identity of every watched directory; null while any changed too recently for a signature to be trusted. */
function watchedSignature(watched: string[]): string | null {
  const keys: string[] = []
  for (const path of watched) {
    let st
    try { st = statSync(path, { bigint: true }) } catch { keys.push('missing'); continue }
    const key = settledFileStatKey(path, st)
    if (key === null) return null
    keys.push(key)
  }
  return keys.join('|')
}

// One server has one set of homes. Holds paths only, and every decision revalidates the signature.
let cachedPolicyScope: { key: string; signature: string | null; scope: MediaPolicyScope } | null = null

function mediaPolicyScope(deps: Pick<MediaPolicyDeps, 'home' | 'hermesHome' | 'stateDir'>): MediaPolicyScope {
  const key = JSON.stringify([deps.hermesHome, deps.home, deps.stateDir])
  const cached = cachedPolicyScope
  if (cached?.key === key && cached.signature !== null && watchedSignature(cached.scope.watched) === cached.signature) return cached.scope
  const scope = buildMediaPolicyScope(deps)
  cachedPolicyScope = { key, signature: watchedSignature(scope.watched), scope }
  return scope
}

/** Python `_media_deny_reason` with its roots and workspace resolved once: `real` is the target's resolved path. */
function mediaPolicyDecider(deps: MediaPolicyDeps<string | null>): (target: string, real: string) => string | null {
  const { roots, denyDirs } = mediaPolicyScope(deps)
  const legacySnapshotDir = deps.legacySnapshotDir ? norm(deps.legacySnapshotDir) : null
  const safeWorkspace = (ws: string | null): string | null => {
    if (!ws) return null
    const normalized = norm(ws)
    if (normalized === norm(deps.home)) return null
    if (roots.some((root) => isWithin(root, normalized))) return null
    if (basename(ws) === 'profiles' || basename(resolve(ws, '..')) === 'profiles') return null
    if (DENY_SUBDIRS.includes(basename(ws))) return null
    return normalized
  }
  const workspace = safeWorkspace(deps.activeWorkspace())
  return (target, real) => {
    try {
      const st = statSync(target)
      if (st.isFile() && st.nlink > 1) return 'media file has multiple hard links'
    } catch { /* a missing path is not a hard link */ }
    const normalized = real.toLowerCase()
    if (legacySnapshotDir && isWithin(normalized, legacySnapshotDir)) return 'legacy media snapshot store is internal'
    if (denyDirs.some((dir) => isWithin(normalized, dir))) return 'denied state subdir'
    if (workspace && isWithin(normalized, workspace)) return null
    const name = basename(target).toLowerCase()
    if (roots.some((root) => isWithin(normalized, root)) && (DENY_FILENAMES.has(name) || DENY_TMP_SUFFIXES.some((s) => name.endsWith(s)))) return 'denied state filename'
    return null
  }
}

/** Python `_media_deny_reason`: hard-deny Hermes's own state and secret files. */
export function mediaDenyReasonResolved(target: string, deps: MediaPolicyDeps<string | null>): string | null {
  return mediaPolicyDecider(deps)(target, realOrResolved(target))
}

/**
 * TAL-2205: what a caller without server-owner authority reaches in place of every Hermes home: its profile's home,
 * less the other profiles and the Web state in it, and its own session's attachment folder.
 */
export interface MediaCaller {
  profileHome: string
  /** Every session's attachment folders; only `sessionDir` among them is reachable. */
  attachmentRoot: string
  /** The visible session the request named, else null. */
  sessionDir: string | null
}

/** What `/api/media` authorizes against, besides the session: the homes, the safe temp roots, the active workspace and `MEDIA_ALLOWED_ROOTS`. */
export interface MediaAccessDeps<T = string | null | Promise<string | null>> {
  home: string
  hermesHome: string
  /** `MEDIA_ALLOWED_ROOTS`, separated by the platform's path delimiter. */
  extraRoots: string
  activeWorkspace: () => T
  policy: MediaPolicyDeps<T>
  /** The request's reach without server-owner authority; null for a server owner, who reaches every Hermes home. */
  caller: MediaCaller | null
}

/** The server's media access before a request supplies its authority; `callerScope` builds a restricted caller's reach. */
export type MediaAccessBase = Omit<MediaAccessDeps, 'caller'> & { callerScope: (profile: string | null, sessionId: string | null) => MediaCaller }

/** TAL-2205: the one place a request's authority becomes its media reach. */
export function mediaAccessFor(base: MediaAccessBase, serverOwner: boolean, profile: string | null, sessionId: string | null): MediaAccessDeps {
  return { ...base, caller: serverOwner ? null : base.callerScope(profile, sessionId) }
}

/** The file a `/api/media?path=` value names. Python `Path(raw).resolve()`: no `~` expansion and no NUL bytes; throws on an invalid path. */
export function mediaTarget(rawPath: string): string {
  if (rawPath.includes('\0')) throw new Error('embedded null byte')
  const target = resolvePathLikePython(rawPath.startsWith('~') ? resolve(process.cwd(), rawPath) : rawPath)
  try { return realpathSync(target) } catch { return target } // a missing path keeps its lexical resolution
}

/** The file a `MEDIA:` reference names, resolved once: `mediaRefPath` already yields what `mediaTarget` would. Throws on an invalid path. */
export function mediaRefTarget(ref: string): string {
  if (ref.includes('\0')) throw new Error('embedded null byte')
  return mediaRefPath(ref)
}

/**
 * The `/api/media` decision that needs no session, for resolved targets: the root that authorizes one (which also
 * anchors the open, so a component replaced by a symlink after the check fails the descriptor walk), null when the path
 * is denied, or undefined when only a session-token grant could still authorize it. Everything but the target is
 * resolved once, so one session's references share it.
 */
function mediaRootDecider(deps: MediaAccessDeps<string | null>): (target: string, real: string) => string | null | undefined {
  const baseHermes = join(deps.home, '.hermes')
  const caller = deps.caller
  const allowedRoots: string[] = caller ? [caller.profileHome] : [deps.hermesHome, baseHermes]
  const legacyTmp = safeLegacyTmpRoot([deps.home, deps.hermesHome, baseHermes])
  if (legacyTmp) allowedRoots.push(legacyTmp)
  const platformTemp = safePlatformTempRoot([deps.home, deps.hermesHome, baseHermes])
  if (platformTemp) allowedRoots.push(platformTemp)
  const activeWorkspace = deps.activeWorkspace()
  if (activeWorkspace) allowedRoots.push(activeWorkspace)
  for (const root of deps.extraRoots.trim().split(process.platform === 'win32' ? ';' : ':')) {
    const r = root.trim()
    if (!r) continue
    try {
      const rp = realpathSync(r)
      if (statSync(rp).isDirectory()) allowedRoots.push(rp)
    } catch { /* skip */ }
  }
  // TAL-2205: a restricted caller's session folder comes first, so it anchors before the attachment fence below. A
  // remote store caches the folder only when it downloads a file into it, so it anchors before it exists.
  const resolvedRoots: string[] = caller?.sessionDir ? [realOrResolved(caller.sessionDir)] : []
  for (const root of allowedRoots) {
    try { resolvedRoots.push(realpathSync(root)) } catch { /* a missing root authorizes nothing */ }
  }
  // Inside a restricted caller's profile home (the root profile's home holds the others), every other profile and the
  // Web state, which keeps every session's attachments, stay out of reach.
  const profileHome = caller ? realOrResolved(caller.profileHome) : null
  const fenced = profileHome && caller ? [join(deps.hermesHome, 'profiles'), join(baseHermes, 'profiles'), deps.policy.stateDir, caller.attachmentRoot].map(realOrResolved).filter((dir) => dir !== profileHome && isWithin(dir, profileHome)) : []
  const denyReason = mediaPolicyDecider(deps.policy)
  return (target, real) => {
    if (denyReason(target, real)) return null
    for (const root of resolvedRoots) if (isWithin(target, root) && !(root === profileHome && fenced.some((dir) => isWithin(target, dir)))) return root
    return SESSION_MEDIA_TOKEN_TYPES.has(mimeFor(target)) ? undefined : null
  }
}

/**
 * `mediaRootDecider`, then the file's own directory for a session-token grant. `real` defaults to the target for a
 * caller holding `mediaRefTarget`'s result.
 */
export function mediaAccessResolver(session: Session | null, deps: MediaAccessDeps<string | null>): (target: string, real?: string, allowSessionToken?: boolean) => string | null {
  const decide = mediaRootDecider(deps)
  const sessionGrants = sessionMediaGrant(session)
  return (target, real = target, allowSessionToken = true) => {
    const root = decide(target, real)
    if (root !== undefined) return root
    return allowSessionToken && sessionGrants(target, real) ? dirname(target) : null
  }
}

export async function resolveMediaAccess(deps: MediaAccessDeps): Promise<MediaAccessDeps<string | null>> {
  const [workspace, policyWorkspace] = await Promise.all([deps.activeWorkspace(), deps.policy.activeWorkspace()])
  return { ...deps, activeWorkspace: () => workspace, policy: { ...deps.policy, activeWorkspace: () => policyWorkspace } }
}

export async function mediaDenyReason(target: string, deps: MediaPolicyDeps): Promise<string | null> {
  const workspace = await deps.activeWorkspace()
  return (mediaDenyReasonResolved(target, { ...deps, activeWorkspace: () => workspace }))
}

/** One `/api/media` decision: see `mediaRootDecider`. A session given as a function is loaded only when its transcript can decide. */
export async function mediaAnchorRoot(target: string, session: Session | null | (() => Promise<Session | null>), deps: MediaAccessDeps): Promise<string | null> {
  const real = realOrResolved(target)
  const root = mediaRootDecider(await resolveMediaAccess(deps))(target, real)
  if (root !== undefined) return root
  return sessionMediaGrant(typeof session === 'function' ? await session() : session)(target, real) ? dirname(target) : null
}
