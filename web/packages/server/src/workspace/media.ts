/**
 * Byte-serving helpers and the `/api/media` allow/deny model (Python
 * `_serve_file_bytes`, `_media_deny_reason`, and `_session_media_token_allows_path`).
 */
import { closeSync, createReadStream, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { createHash } from 'node:crypto'
import type { RequestContext } from '../http/context.js'
import { NotFoundError, openAnchoredFd } from './fs.js'
import { isWithin, resolvePathLikePython } from './paths.js'
import { str } from '../util.js'
import type { Session } from '../sessions/session.js'

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
const ETAG_SIZE_CAP = 10 * 1024 * 1024
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

function readAll(fd: number, size: number): Buffer {
  const chunks: Buffer[] = []
  let remaining = size
  const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, size)))
  let position = 0
  while (remaining > 0) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, remaining), position)
    if (n <= 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
    remaining -= n
    position += n
  }
  return Buffer.concat(chunks)
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
}

/** Serve a file with MIME/disposition, weak ETag revalidation, and single byte ranges. */
export function serveFileBytes(ctx: RequestContext, target: string, opts: ServeFileOptions): void {
  let fd: number | null = null
  let fileSize: number
  try {
    fd = opts.anchorRoot ? openAnchoredFd(opts.anchorRoot, resolvePathLikePython(target), { wantDir: false }) : openSync(target, fsConstants.O_RDONLY)
    const st = fstatSync(fd)
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' })
    if (opts.denyHardLinks && st.nlink > 1) { closeSync(fd); ctx.json({ error: 'Path not in allowed location' }, { status: 403 }); return }
    fileSize = st.size
  } catch (error) {
    if (fd !== null) closeSync(fd)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') { ctx.json({ error: 'Permission denied' }, { status: 403 }); return }
    if (error instanceof NotFoundError || code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP') { ctx.json({ error: 'not found' }, { status: 404 }); return }
    if (error instanceof Error && !code) { ctx.json({ error: sanitizeError(error) }, { status: 403 }); return }
    ctx.json({ error: 'Could not stat file' }, { status: 500 })
    return
  }
  try {
    let etag: string | null = null
    let snapshot: Buffer | null = null
    if (!opts.cacheControl.includes('no-store') && fileSize <= ETAG_SIZE_CAP) {
      snapshot = readAll(fd, fileSize)
      if (snapshot.length === fileSize && fileSize > 0) etag = `W/"${createHash('sha256').update(snapshot).digest('hex')}"`
      fileSize = snapshot.length
    }
    const baseHeaders: Record<string, string> = { 'Cache-Control': opts.cacheControl }
    if (etag && ifNoneMatchMatches(ctx.header('if-none-match'), etag)) {
      ctx.send({ status: 304, headers: { ...baseHeaders, ETag: etag } })
      return
    }
    const rangeHeader = ctx.header('range')
    const byteRange = parseRangeHeader(rangeHeader, fileSize)
    if (rangeHeader && !byteRange) {
      ctx.send({ status: 416, headers: { 'Content-Range': `bytes */${String(fileSize)}`, 'Accept-Ranges': 'bytes' } })
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
    if (!contentLength || snapshot) {
      ctx.send({ status: byteRange ? 206 : 200, headers, body: snapshot ? snapshot.subarray(start, start + contentLength) : Buffer.alloc(0), security: !opts.csp })
      return
    }
    // Large files stream the selected span from the descriptor with backpressure (Python copied bounded chunks); the
    // stream owns the descriptor from here.
    ctx.sendStream({ status: byteRange ? 206 : 200, headers: { ...headers, 'Content-Length': String(contentLength) }, security: !opts.csp }, createReadStream('', { fd, start, end: start + contentLength - 1, autoClose: true, highWaterMark: 256 * 1024 }))
    fd = -1
  } finally {
    if (fd !== -1) closeSync(fd)
  }
}

/** Sandboxed inline HTML keeps framing allowed (no X-Frame-Options) but pins CSP. */
export function previewHeaders(csp: string): Record<string, string> {
  return { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': PREVIEW_PERMISSIONS_POLICY }
}

export function htmlPreviewWithBlankBase(raw: Buffer): Buffer {
  return htmlWithHeadTag(raw, '<base target="_blank">')
}

/** Insert `base` as the first `<head>` child, creating the head after any doctype so the page keeps standards mode. */
export function htmlWithHeadTag(raw: Buffer, base: string): Buffer {
  let text = raw.toString('utf8')
  if (/<head(?:\s[^>]*)?>/i.test(text)) text = text.replace(/(<head\b[^>]*>)/i, `$1${base}`)
  else if (/<!doctype[^>]*>/i.test(text)) text = text.replace(/(<!doctype[^>]*>)/i, `$1<head>${base}</head>`)
  else text = `<head>${base}</head>${text}`
  return Buffer.from(text, 'utf8')
}

export function serveInlineHtmlPreview(ctx: RequestContext, target: string, cacheControl: string, csp: string, anchorRoot: string | null): void {
  let body: Buffer | null = null
  try {
    const fd = anchorRoot ? openAnchoredFd(anchorRoot, resolvePathLikePython(target), { wantDir: false }) : openSync(target, fsConstants.O_RDONLY)
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' })
      // The preview is rewritten in memory; anything past the buffering cap is served as a download instead.
      if (st.size <= ETAG_SIZE_CAP) body = htmlPreviewWithBlankBase(readAll(fd, st.size))
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') { ctx.json({ error: 'Permission denied' }, { status: 403 }); return }
    if (error instanceof NotFoundError || code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP') { ctx.json({ error: 'not found' }, { status: 404 }); return }
    if (error instanceof Error && !code) { ctx.json({ error: sanitizeError(error) }, { status: 403 }); return }
    ctx.json({ error: 'Could not read file' }, { status: 500 })
    return
  }
  if (!body) {
    serveFileBytes(ctx, target, { mime: 'text/html', disposition: 'attachment', cacheControl, anchorRoot })
    return
  }
  ctx.send({
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

/** Allow exact safe `MEDIA:` paths the assistant/tool emitted in the requested session. */
export function sessionMediaTokenAllowsPath(session: Session | null, target: string, allowedMimes: Set<string>): boolean {
  if (!session) return false
  if (!allowedMimes.has(mimeFor(target))) return false
  let targetResolved: string
  try { targetResolved = realpathSync(target) } catch { targetResolved = resolvePathLikePython(target) }
  for (const message of session.messages) {
    if (!message || typeof message !== 'object') continue
    const role = str((message as { role?: unknown }).role).trim().toLowerCase()
    if (role === 'user') continue
    const text = messageContentText((message as { content?: unknown }).content)
    if (!text.includes('MEDIA:')) continue
    for (const m of text.matchAll(MEDIA_TOKEN_RE)) {
      const ref = m[1] ?? ''
      if (ref.includes('://')) continue
      try {
        const expanded = mediaRefPath(ref)
        let resolved = expanded
        try { resolved = realpathSync(expanded) } catch { /* keep */ }
        if (resolved === targetResolved) return true
      } catch { /* skip */ }
    }
  }
  return false
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

export interface MediaPolicyDeps {
  home: string
  hermesHome: string
  stateDir: string
  /** The active workspace when local IO is supported, else null. */
  activeWorkspace: () => string | null
}

const DENY_FILENAMES = new Set(['settings.json', 'state.db', 'state.db-wal', 'state.db-shm', 'auth.json', 'auth.lock', 'config.yaml', 'config.yml', '.env', '.signing_key', '.pbkdf2_key', '.sessions.json', 'google_token.json', 'google_client_secret.json', 'gateway_state.json', 'channel_directory.json', 'jobs.json', 'passkeys.json', '.passkey_challenges.json', '.login_attempts.json'])
const DENY_SUBDIRS = ['sessions', 'memories', 'cron', 'logs', 'checkpoints', 'backups', 'media_snapshots']
const DENY_TMP_SUFFIXES = ['.sessions.tmp', '.login_attempts.tmp', '.passkeys.tmp', '.passkey_challenges.tmp']

function norm(p: string): string {
  let resolved = p
  try { resolved = realpathSync(p) } catch { resolved = resolvePathLikePython(p) }
  return resolved.toLowerCase()
}
const withinCi = (child: string, root: string): boolean => { const c = norm(child); const r = norm(root); return c === r || isWithin(c, r) }
const equalCi = (a: string, b: string): boolean => norm(a) === norm(b)

/** Python `_media_deny_reason`: hard-deny Hermes's own state and secret files. */
export function mediaDenyReason(target: string, deps: MediaPolicyDeps): string | null {
  try {
    const st = statSync(target)
    if (st.isFile() && st.nlink > 1) return 'media file has multiple hard links'
  } catch { /* a missing path is not a hard link */ }
  const roots: string[] = []
  for (const r of [deps.hermesHome, join(deps.home, '.hermes'), deps.stateDir]) {
    const resolved = norm(r)
    if (!roots.some((x) => norm(x) === resolved)) roots.push(r)
  }
  const profileRoots: string[] = []
  for (const root of [...roots]) {
    const profilesDir = join(root, 'profiles')
    try {
      for (const child of readdirSync(profilesDir, { withFileTypes: true })) {
        if (!child.isDirectory()) continue
        const pr = join(profilesDir, child.name)
        if (!roots.some((x) => equalCi(x, pr)) && !profileRoots.some((x) => equalCi(x, pr))) profileRoots.push(pr)
      }
    } catch { /* no profiles dir */ }
  }
  roots.push(...profileRoots)
  const denyDirs: string[] = []
  for (const root of roots) {
    for (const sub of DENY_SUBDIRS) denyDirs.push(join(root, sub), join(root, 'webui_state', sub))
  }
  const activeWorkspace = deps.activeWorkspace()
  const safeCarveout = (ws: string | null): boolean => {
    if (!ws) return false
    if (equalCi(ws, deps.home)) return false
    for (const root of roots) if (equalCi(ws, root) || withinCi(root, ws)) return false
    if (basename(ws) === 'profiles' || basename(resolve(ws, '..')) === 'profiles') return false
    if (DENY_SUBDIRS.includes(basename(ws))) return false
    return true
  }
  const inActiveWorkspace = activeWorkspace !== null && safeCarveout(activeWorkspace) && withinCi(target, activeWorkspace)
  if (denyDirs.some((d) => withinCi(target, d))) return 'denied state subdir'
  if (!inActiveWorkspace) {
    const underRoot = roots.some((root) => withinCi(target, root))
    const name = basename(target).toLowerCase()
    if (underRoot && (DENY_FILENAMES.has(name) || DENY_TMP_SUFFIXES.some((s) => name.endsWith(s)))) return 'denied state filename'
  }
  return null
}

/** What `/api/media` authorizes against, besides the session: the homes, the safe temp roots, the active workspace and `MEDIA_ALLOWED_ROOTS`. */
export interface MediaAccessDeps {
  home: string
  hermesHome: string
  /** `MEDIA_ALLOWED_ROOTS`, separated by the platform's path delimiter. */
  extraRoots: string
  activeWorkspace: () => string | null
  policy: MediaPolicyDeps
}

/** The file a `/api/media?path=` value names. Python `Path(raw).resolve()`: no `~` expansion and no NUL bytes; throws on an invalid path. */
export function mediaTarget(rawPath: string): string {
  if (rawPath.includes('\0')) throw new Error('embedded null byte')
  const target = resolvePathLikePython(rawPath.startsWith('~') ? resolve(process.cwd(), rawPath) : rawPath)
  try { return realpathSync(target) } catch { return target } // a missing path keeps its lexical resolution
}

/**
 * The `/api/media` decision for a resolved target: the root that authorizes it (which also anchors the open, so a
 * component replaced by a symlink after the check fails the descriptor walk), the file's own directory for a
 * session-token grant, or null when the path is denied.
 */
export function mediaAnchorRoot(target: string, session: Session | null, deps: MediaAccessDeps): string | null {
  const baseHermes = join(deps.home, '.hermes')
  const allowedRoots: string[] = [deps.hermesHome, baseHermes]
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
  if (mediaDenyReason(target, deps.policy)) return null
  for (const root of allowedRoots) {
    let resolvedRoot: string
    try { resolvedRoot = realpathSync(root) } catch { continue }
    if (target === resolvedRoot || isWithin(target, resolvedRoot)) return resolvedRoot
  }
  return sessionMediaTokenAllowsPath(session, target, SESSION_MEDIA_TOKEN_TYPES) ? dirname(target) : null
}
