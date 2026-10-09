/**
 * Byte-stream routes that bypass oRPC: raw file bodies, chat media, folder
 * ZIPs, transcript exports, and multipart uploads. Each mirrors its Python
 * handler and reuses the anchored file helpers.
 */
import { closeSync, createReadStream, existsSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { Readable } from 'node:stream'
import { basename, join, relative } from 'node:path'
import type { RequestContext } from '../http/context.js'
import { HttpError } from './router.js'
import { fileOpsSession } from './sessions-router.js'
import { HttpFailure } from '../sessions/service.js'
import { SessionNotFound } from '../sessions/store.js'
import { openAnchoredFd, safeResolve } from '../workspace/fs.js'
import { isWithin, resolvePathLikePython } from '../workspace/paths.js'
import { isLoopback } from '../http/origin.js'
import { truthy } from '../config.js'
import { AUDIO_VIDEO_PDF_TYPES, contentDispositionValue, INLINE_IMAGE_TYPES, isValidDigest, mediaAnchorRoot, mediaTarget, mimeFor, serveFileBytes, serveInlineHtmlPreview, snapshotPathForDigest, snapshotServableForPath } from '../workspace/media.js'
import { PREVIEW_PREFIX, previewGrantRoot } from '../workspace/preview.js'
import { REMOTE_WORKSPACE_UNSUPPORTED_CODE, REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE } from '../workspace/workspaces.js'
import { ZipWriter } from '../workspace/zip.js'
import { parseMultipart, UploadConflict, UploadRejected } from '../workspace/upload.js'
import { pythonPrettyJson, renderSessionHtml } from '../sessions/export.js'
import type { Session } from '../sessions/session.js'
import { handleCspReport, handleTranscribe, handleTts } from './tools-raw.js'
import { handleOidcCallback, handleOidcStart } from './auth-raw.js'

const SANDBOX_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox'
const DANGEROUS_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml'])

type RawHandler = (ctx: RequestContext) => Promise<void> | void

export const RAW_GET_ROUTES: Record<string, RawHandler> = {
  '/api/auth/oidc/start': handleOidcStart,
  '/api/auth/oidc/callback': handleOidcCallback,
  '/api/file/raw': handleFileRaw,
  '/api/media': handleMedia,
  '/api/folder/download': handleFolderDownload,
  '/api/session/export': handleSessionExport,
  '/api/approval/inject_test': testHook(handleApprovalInject),
  '/api/clarify/inject_test': testHook(handleClarifyInject),
}

export const RAW_POST_ROUTES: Record<string, RawHandler> = {
  '/api/upload': handleUpload,
  '/api/transcribe': handleTranscribe,
  '/api/tts': handleTts,
  '/api/csp-report': handleCspReport,
  '/api/process-complete-ack': handleProcessCompleteAck,
}

/** Run a raw handler, translating thrown `HttpError`s into the JSON error body. */
export async function runRaw(ctx: RequestContext, handler: RawHandler): Promise<void> {
  try {
    await handler(ctx)
  } catch (error) {
    if (ctx.isFinished) return
    if (error instanceof HttpError) {
      ctx.json({ error: error.message, ...error.data }, { status: error.status })
      return
    }
    if (error instanceof HttpFailure) {
      ctx.json({ error: error.message, ...error.extra }, { status: error.status })
      return
    }
    if (error instanceof SessionNotFound) {
      ctx.json({ error: 'Session not found' }, { status: 404 })
      return
    }
    throw error
  }
}

/** Retired by the `process_complete` -> `bg_task_complete` rename: always 410, naming the replacement. */
function handleProcessCompleteAck(ctx: RequestContext): void {
  ctx.json({ error: 'gone: /api/process-complete-ack was replaced by /api/bg-task-complete-ack as part of the process_complete -> bg_task_complete event rename', replaced_by: '/api/bg-task-complete-ack' }, { status: 410, headers: { 'X-Replaced-By': '/api/bg-task-complete-ack' } })
}

/**
 * Automated-test hooks: served only to a loopback peer while `HERMES_WEBUI_TEST_HOOKS=1` is set (loopback alone means
 * nothing behind a same-host reverse proxy); anything else gets the plain 404.
 */
function testHook(handler: RawHandler): RawHandler {
  return (ctx) => {
    if (!truthy(ctx.deps.config.env.HERMES_WEBUI_TEST_HOOKS) || !isLoopback(ctx.peer)) {
      ctx.json({ error: 'not found' }, { status: 404 })
      return
    }
    return handler(ctx)
  }
}

/** Queue a fake approval; `_injected` entries are answered locally, since no Agent is parked on them. */
function handleApprovalInject(ctx: RequestContext): void {
  const sid = ctx.query.get('session_id') ?? ''
  if (!sid) throw new HttpError(400, 'session_id required')
  const key = ctx.query.get('pattern_key') || 'test_pattern'
  ctx.deps.pending.submitApproval(sid, { command: ctx.query.get('command') || 'rm -rf /tmp/test', pattern_key: key, pattern_keys: [key], description: 'test pattern', session_id: sid, _injected: true })
  ctx.json({ ok: true, session_id: sid })
}

/** Queue a fake clarify prompt (repeated `choices`); answered locally like an injected approval. */
function handleClarifyInject(ctx: RequestContext): void {
  const sid = ctx.query.get('session_id') ?? ''
  if (!sid) throw new HttpError(400, 'session_id required')
  ctx.deps.pending.submitClarify(sid, { question: ctx.query.get('question') || 'Which option?', choices_offered: ctx.query.getAll('choices').filter(Boolean), session_id: sid, kind: 'clarify', _injected: true })
  ctx.json({ ok: true, session_id: sid })
}

function fileRawTarget(ctx: RequestContext, workspace: string, sid: string, rel: string): [string, string] | null {
  try {
    const target = safeResolve(workspace, rel)
    if (existsSync(target) && statSync(target).isFile()) return [workspace, target]
  } catch { /* fall through to the attachment inbox */ }
  try {
    const attachmentRoot = ctx.deps.uploads.sessionDir(sid)
    const target = safeResolve(attachmentRoot, rel)
    if (existsSync(target) && statSync(target).isFile()) return [attachmentRoot, target]
  } catch { /* none */ }
  return null
}

function handleFileRaw(ctx: RequestContext): void {
  const sid = ctx.query.get('session_id') ?? ''
  if (!sid) throw new HttpError(400, 'session_id is required')
  const s = fileOpsSession(ctx, sid)
  const rel = ctx.query.get('path') ?? ''
  if (rel.includes('\0')) throw new HttpError(400, 'invalid path')
  const forceDownload = ctx.query.get('download') === '1'
  const resolved = fileRawTarget(ctx, s.workspace, sid, rel)
  if (!resolved) {
    ctx.json({ error: 'not found' }, { status: 404 })
    return
  }
  const [anchorRoot, target] = resolved
  const mime = mimeFor(target)
  const inlinePreview = ctx.query.get('inline') === '1'
  const htmlInlineOk = inlinePreview && mime === 'text/html'
  const disposition = forceDownload || (DANGEROUS_TYPES.has(mime) && !htmlInlineOk) ? 'attachment' : 'inline'
  const csp = inlinePreview && !forceDownload && disposition === 'inline' ? SANDBOX_CSP : null
  if (htmlInlineOk) {
    serveInlineHtmlPreview(ctx, target, 'no-store', SANDBOX_CSP, anchorRoot)
    return
  }
  serveFileBytes(ctx, target, { mime, disposition, cacheControl: 'no-store', csp, anchorRoot })
}

/**
 * `/workspace-preview/<grant>/<path>` (TAL-566): the HTML preview frame and its relative assets, authorized by the
 * signed grant rather than a cookie. Every response carries the sandbox CSP and no CORS header, so the page's scripts
 * can run and load assets but cannot read workspace files.
 */
export function handleWorkspacePreview(ctx: RequestContext): void {
  const rest = ctx.path.slice(PREVIEW_PREFIX.length)
  const slash = rest.indexOf('/')
  const root = slash > 0 ? previewGrantRoot(ctx.deps.auth.signingKey(), rest.slice(0, slash)) : null
  let target: string | null = null
  if (root) {
    try {
      const rel = decodeURIComponent(rest.slice(slash + 1))
      const resolved = rel.includes('\0') ? null : safeResolve(root, rel)
      if (resolved && existsSync(resolved) && statSync(resolved).isFile()) target = resolved
    } catch { /* malformed escape or outside the root */ }
  }
  if (!root || !target) {
    ctx.json({ error: 'not found' }, { status: 404 })
    return
  }
  const mime = mimeFor(target)
  if (mime === 'text/html') serveInlineHtmlPreview(ctx, target, 'no-store', SANDBOX_CSP, root)
  else serveFileBytes(ctx, target, { mime, disposition: 'inline', cacheControl: 'no-store', csp: SANDBOX_CSP, anchorRoot: root })
}

function handleMedia(ctx: RequestContext): void {
  const { deps } = ctx
  const rawPath = (ctx.query.get('path') ?? '').trim()
  if (!rawPath) throw new HttpError(400, 'path parameter required')
  const sessionId = ctx.query.get('session_id') ?? ''
  let mediaSession: Session | null = null
  let localAllowed: boolean
  if (sessionId) {
    try {
      mediaSession = deps.sessionStore.get(sessionId)
    } catch {
      throw new HttpError(404, 'Session not found')
    }
    localAllowed = deps.workspaces.profileSupportsLocalIo(mediaSession.profile)
  } else localAllowed = deps.workspaces.profileSupportsLocalIo(null)
  if (!localAllowed) {
    ctx.json({ error: REMOTE_WORKSPACE_UNSUPPORTED_CODE, message: REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE }, { status: 400 })
    return
  }
  let target: string
  try {
    target = mediaTarget(rawPath)
  } catch {
    throw new HttpError(400, 'Invalid path')
  }
  const anchorRoot = mediaAnchorRoot(target, mediaSession, deps.mediaAccess)
  if (!anchorRoot) throw new HttpError(403, 'Path not in allowed location')
  const mime = mimeFor(target)
  const inlinePreview = ctx.query.get('inline') === '1'
  const htmlInlineOk = inlinePreview && mime === 'text/html'
  const inlinePreviewTypes = new Set([...INLINE_IMAGE_TYPES, ...AUDIO_VIDEO_PDF_TYPES])
  const disposition = mime !== 'image/svg+xml' && (INLINE_IMAGE_TYPES.has(mime) || (inlinePreview && inlinePreviewTypes.has(mime)) || htmlInlineOk) ? 'inline' : 'attachment'
  const csp = htmlInlineOk ? 'sandbox allow-scripts' : null
  const snapDigest = (ctx.query.get('snap') ?? '').trim().toLowerCase()
  if (snapDigest) {
    const snapDir = resolvePathLikePython(deps.mediaPolicy.snapshotDir())
    if (isValidDigest(snapDigest)) {
      let snapshotFile = snapshotPathForDigest(snapDir, snapDigest)
      if (snapshotFile && !snapshotServableForPath(snapDir, snapDigest, target)) snapshotFile = null
      if (!snapshotFile) {
        ctx.json({ error: 'snapshot unavailable' }, { status: 410 })
        return
      }
      // Same inode rule as live media: a `.snap` replaced by a hard link to a state file must not be served as the snapshot.
      serveFileBytes(ctx, snapshotFile, { mime, disposition, cacheControl: 'private, max-age=31536000, immutable', csp, downloadName: basename(target), anchorRoot: snapDir, denyHardLinks: true })
      return
    }
  }
  // The pathname policy ran before the open; the hard-link rule is re-applied to the inode actually opened.
  serveFileBytes(ctx, target, { mime, disposition, cacheControl: mime === 'text/html' ? 'no-store' : 'private, no-cache', csp, anchorRoot, denyHardLinks: true })
}

/** Python `_folder_zip_limits`: `HERMES_WEBUI_FOLDER_ZIP_MAX_MB` / `_MAX_FILES` are honoured as given (ZIP64 covers large archives). */
export function folderZipMaxBytes(env: Record<string, string | undefined>): number {
  const mb = Number.parseInt((env.HERMES_WEBUI_FOLDER_ZIP_MAX_MB ?? '1024').trim(), 10)
  return Math.max(1, Number.isFinite(mb) ? mb : 1024) * 1024 * 1024
}

export function folderZipMaxFiles(env: Record<string, string | undefined>): number {
  const n = Number.parseInt((env.HERMES_WEBUI_FOLDER_ZIP_MAX_FILES ?? '50000').trim(), 10)
  return Math.max(1, Number.isFinite(n) ? n : 50000)
}

function collectFolder(target: string, workspaceRoot: string, maxBytes: number, maxFiles: number): { files: [string, string, number][]; total: number; limit: 'max_files' | 'max_bytes' | null } {
  const files: [string, string, number][] = []
  let total = 0
  const stack = [target]
  while (stack.length) {
    const dir = stack.pop()!
    let realDir: string
    try { realDir = realpathSync(dir) } catch { continue }
    if (realDir !== workspaceRoot && !isWithin(realDir, workspaceRoot)) continue
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    const subdirs: string[] = []
    for (const entry of entries) {
      const fp = join(dir, entry.name)
      if (entry.isDirectory()) { subdirs.push(fp); continue }
      if (entry.isSymbolicLink()) {
        try {
          const real = realpathSync(fp)
          if (real !== workspaceRoot && !isWithin(real, workspaceRoot)) continue
          if (statSync(real).isDirectory()) continue
        } catch { continue }
      } else if (!entry.isFile()) continue
      let size: number
      try { size = statSync(fp).size } catch { continue }
      if (files.length >= maxFiles) return { files, total, limit: 'max_files' }
      const arcname = relative(target, fp)
      // Python compares the raw file bytes against the cap; record overhead is not charged.
      if (total + size > maxBytes) return { files, total, limit: 'max_bytes' }
      files.push([fp, arcname, size])
      total += size
    }
    for (const sub of subdirs.reverse()) stack.push(sub)
  }
  return { files, total, limit: null }
}

async function handleFolderDownload(ctx: RequestContext): Promise<void> {
  const sid = ctx.query.get('session_id') ?? ''
  if (!sid) throw new HttpError(400, 'session_id is required')
  const s = fileOpsSession(ctx, sid)
  const rel = ctx.query.get('path') ?? ''
  let target: string
  try {
    target = safeResolve(s.workspace, rel)
  } catch {
    throw new HttpError(400, 'invalid path')
  }
  if (!existsSync(target)) {
    ctx.json({ error: 'not found' }, { status: 404 })
    return
  }
  if (!statSync(target).isDirectory()) throw new HttpError(400, 'path must be a directory; use /api/file/raw for single files')
  const workspaceRoot = realpathSync(s.workspace)
  const maxBytes = folderZipMaxBytes(ctx.deps.config.env)
  const maxFiles = folderZipMaxFiles(ctx.deps.config.env)
  const { files, limit } = collectFolder(target, workspaceRoot, maxBytes, maxFiles)
  if (limit === 'max_files') {
    ctx.json({ error: 'too many files', limit: maxFiles, configure: 'HERMES_WEBUI_FOLDER_ZIP_MAX_FILES' }, { status: 413 })
    return
  }
  if (limit === 'max_bytes') {
    ctx.json({ error: 'folder too large', limit_bytes: maxBytes, configure: 'HERMES_WEBUI_FOLDER_ZIP_MAX_MB' }, { status: 413 })
    return
  }
  const zipName = `${basename(target) || 'workspace'}.zip`
  ctx.res.writeHead(200, { ...ctx.securityHeaders(), 'Content-Type': 'application/zip', 'Content-Disposition': contentDispositionValue('attachment', zipName), 'Cache-Control': 'no-store' })
  ctx.markFinished(200)
  if (ctx.method === 'HEAD') { ctx.res.end(); return }
  const zip = new ZipWriter(ctx.res)
  try {
    for (const [fp, arcname, size] of files) {
      let fd: number
      try {
        fd = openAnchoredFd(workspaceRoot, realpathSync(fp), { wantDir: false })
      } catch (error) {
        ctx.deps.log(`[webui] WARNING: folder-download: skipping ${fp}: ${(error as Error).message}`)
        continue
      }
      // The preflight sized the archive from these stats; a file that grows afterwards contributes only the bytes it
      // had then, so the streamed total never exceeds the admitted limit (an empty file streams nothing).
      const body = size > 0 ? createReadStream('', { fd, autoClose: true, start: 0, end: size - 1 }) : (closeSync(fd), Readable.from([]))
      // Skip (not abort) an entry that fails mid-read, as Python did; the archive stays valid.
      try { await zip.addFile(arcname, body, size) } catch (error) { if (ctx.res.destroyed) return; ctx.deps.log(`[webui] WARNING: folder-download: skipping ${fp}: ${(error as Error).message}`) }
    }
    await zip.finish()
  } finally {
    ctx.res.end()
  }
}

function handleSessionExport(ctx: RequestContext): void {
  const sid = ctx.query.get('session_id') ?? ''
  if (!sid) throw new HttpError(400, 'session_id is required')
  let session: Session
  try {
    session = ctx.deps.sessionStore.get(sid)
  } catch {
    throw new HttpError(404, 'Session not found')
  }
  if (!ctx.deps.profilesMatch(session.profile, ctx.deps.activeProfile())) throw new HttpError(404, 'Session not found')
  // Python `public_session_projection(s.__dict__)`: the whole session document (tool_calls, context_messages, ...) redacted.
  const safe = ctx.deps.sessions.publicSessionDocument(session)
  const fmt = (ctx.query.get('format') ?? 'json').toLowerCase()
  let payload: string
  let contentType: string
  let ext: string
  if (fmt === 'html') {
    const theme = (ctx.query.get('theme') ?? 'dark').toLowerCase()
    let palette: unknown = null
    const rawPalette = ctx.query.get('palette') ?? ''
    if (rawPalette) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(rawPalette, 'base64').toString('utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length <= 64) palette = parsed
      } catch { palette = null }
    }
    payload = renderSessionHtml(safe, theme, palette)
    contentType = 'text/html; charset=utf-8'
    ext = 'html'
  } else {
    payload = pythonPrettyJson(safe)
    contentType = 'application/json; charset=utf-8'
    ext = 'json'
  }
  ctx.send({ status: 200, headers: { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="hermes-${sid}.${ext}"`, 'Cache-Control': 'no-store' }, body: Buffer.from(payload, 'utf8') })
}

async function handleUpload(ctx: RequestContext): Promise<void> {
  const maxBytes = ctx.deps.config.maxUploadBytes
  const contentType = ctx.header('content-type') ?? ''
  const contentLength = Number.parseInt(ctx.header('content-length') ?? '0', 10) || 0
  if (contentLength > maxBytes) {
    ctx.json({ error: `File too large (max ${String(Math.floor(maxBytes / 1024 / 1024))}MB)` }, { status: 413 })
    return
  }
  let raw: Buffer
  try {
    raw = await ctx.readRawBody(maxBytes)
  } catch {
    // Node's parser already answers a garbage or negative Content-Length with 400 before this handler runs.
    ctx.json({ error: `Upload too large (max ${String(maxBytes)} bytes)` }, { status: 400 })
    return
  }
  let parsed
  try {
    parsed = parseMultipart(raw, contentType)
  } catch (error) {
    ctx.json({ error: (error as Error).message }, { status: 400 })
    return
  }
  const sessionId = parsed.fields.session_id ?? ctx.query.get('session_id') ?? ''
  const file = parsed.files.file
  if (!file) {
    ctx.json({ error: 'No file field in request' }, { status: 400 })
    return
  }
  if (!file.filename) {
    ctx.json({ error: 'No filename in upload' }, { status: 400 })
    return
  }
  let session: Session
  try {
    session = ctx.deps.sessionStore.get(sessionId, { metadataOnly: true })
  } catch {
    ctx.json({ error: 'Session not found' }, { status: 404 })
    return
  }
  if (!ctx.deps.profilesMatch(session.profile, ctx.deps.activeProfile())) {
    ctx.json({ error: 'Session not found' }, { status: 404 })
    return
  }
  try {
    ctx.json(ctx.deps.uploads.store(sessionId, file.filename, file.body))
  } catch (error) {
    if (error instanceof UploadConflict) { ctx.json({ error: error.message }, { status: 409 }); return }
    if (error instanceof UploadRejected) { ctx.json({ error: error.message }, { status: 403 }); return }
    if (error instanceof Error && error.message === 'Invalid filename') { ctx.json({ error: error.message }, { status: 400 }); return }
    ctx.deps.log(`[webui] upload error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    ctx.json({ error: 'Upload failed' }, { status: 500 })
  }
}
