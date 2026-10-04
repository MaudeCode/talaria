import { str } from '../util.js'
/**
 * Public share snapshots (Python `api/shares.py`): sanitized read-only copies
 * of a conversation under `shares/<token>.json`. Only user/assistant prose is
 * published; credentials and local paths are always redacted; local MEDIA:
 * references become inline images only when they resolve inside an allowed
 * root and pass the image allow-list.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, join, resolve } from 'node:path'
import { atomicWriteText } from '../fs/atomic.js'
import { redactSensitive } from '../redact.js'
import { expandHome, isWithin, resolvePathLikePython } from '../workspace/paths.js'
import { openAnchoredFd } from '../workspace/fs.js'
import type { Session } from './session.js'
import { normalizeAssistantDisplay } from './merge.js'

const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/
const SHARE_MEDIA_RE = /MEDIA:(?!https?:\/\/)([^\s)\]>]+)/g
const SHARE_EMBED_MAX_BYTES = 512 * 1024
const ALLOWED_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const PLACEHOLDER = '[*Local attachment omitted from public share*]'
const IMAGE_MAGIC: Record<string, Buffer> = { 'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]), 'image/gif': Buffer.from('GIF8'), 'image/webp': Buffer.from('RIFF') }

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

function shareMessageText(message: Record<string, unknown>): string {
  const content = message.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) if (isDict(item) && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    return parts.join('').trim()
  }
  if (typeof content === 'string') return content.trim()
  return ''
}

export function redactSharePaths(text: string, extraPaths: string[]): string {
  let out = text
  for (const p of extraPaths) {
    const path = (p ?? '').trim()
    if (path.length >= 4 && out.includes(path)) out = out.split(path).join('[redacted-path]')
  }
  return out
}

function checkImageMagic(data: Buffer, mime: string): boolean {
  const magic = IMAGE_MAGIC[mime]
  if (!magic || !data.subarray(0, magic.length).equals(magic)) return false
  if (mime === 'image/webp') return data.length >= 12 && data.subarray(8, 12).toString() === 'WEBP'
  return true
}

/** The candidate file and the allowed root it sits under; the bytes are then read through an anchored walk from that root. */
function resolveAgainstRoots(raw: string, allowed: string[], home: string): { path: string; root: string } | null {
  if (raw.startsWith('file://')) return null
  if (raw.startsWith('/') || raw.startsWith('~')) {
    let p: string
    try { p = resolvePathLikePython(expandHome(raw, home), home) } catch { return null }
    const root = allowed.find((r) => isWithin(p, r))
    return root && isFile(p) ? { path: p, root } : null
  }
  for (const root of allowed) {
    let candidate: string
    try { candidate = resolvePathLikePython(resolve(root, raw), home) } catch { continue }
    if (!isWithin(candidate, root)) continue
    if (isFile(candidate)) return { path: candidate, root }
  }
  return null
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

/** The file's bytes read through the anchored walk (no symlinked component, nothing swapped since resolution), or null. */
function readAnchoredImage(root: string, path: string): Buffer | null {
  let fd: number
  try { fd = openAnchoredFd(root, path, { wantDir: false }) } catch { return null }
  try {
    const st = fstatSync(fd)
    // A hard link to a private image outside the roots passes the pathname walk; the inode's link count does not.
    if (!st.isFile() || st.nlink > 1 || st.size > SHARE_EMBED_MAX_BYTES) return null
    return readFileSync(fd)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

export function embedShareMedia(text: string, allowedRoots: string[], home: string): string {
  if (!text) return text
  const allowed = allowedRoots.filter(Boolean).map((r) => resolvePathLikePython(r, home))
  return text.replace(SHARE_MEDIA_RE, (whole, rawRef: string) => {
    const raw = rawRef.trim()
    if (!raw) return whole
    const found = resolveAgainstRoots(raw, allowed, home)
    if (found === null) return PLACEHOLDER
    const mime = ALLOWED_MIME[extname(found.path).toLowerCase()]
    if (!mime) return PLACEHOLDER
    const data = readAnchoredImage(found.root, found.path)
    if (!data || !checkImageMagic(data, mime)) return PLACEHOLDER
    return `<img src="data:${mime};base64,${data.toString('base64')}" class="msg-media-img" alt="${escapeHtml(basename(found.path))}" loading="lazy">`
  })
}

export function sanitizeShareMessage(message: unknown, redactPaths: string[], allowedRoots: string[], home: string): Record<string, unknown> | null {
  if (!isDict(message)) return null
  const role = str(message.role).trim().toLowerCase()
  if (role !== 'user' && role !== 'assistant') return null
  // Only the reply's prose is published: inline thinking and leaked tool-call XML never reach a snapshot.
  let text = shareMessageText(normalizeAssistantDisplay({ ...message, role }))
  if (!text) return null
  text = redactSensitive(text)
  text = embedShareMedia(text, allowedRoots, home)
  text = redactSharePaths(text, redactPaths)
  if (!text.trim()) return null
  const sanitized: Record<string, unknown> = { role, content: text }
  if (typeof message.timestamp === 'number') sanitized.timestamp = message.timestamp
  return sanitized
}

export interface ShareSnapshot { title: string; messages: Record<string, unknown>[]; message_count: number }

export function buildShareSnapshot(session: Session, messages: unknown[], opts: { hermesHome: string; attachmentRoot: string; home: string }): ShareSnapshot {
  const redactPaths: string[] = []
  for (const value of [session.workspace, session.worktree_path, session.worktree_repo_root]) if (value) redactPaths.push(value)
  redactPaths.push(opts.hermesHome, opts.home)
  const allowedRoots: string[] = []
  if (session.workspace.trim()) allowedRoots.push(session.workspace.trim())
  allowedRoots.push(opts.attachmentRoot)
  const safe: Record<string, unknown>[] = []
  for (const raw of messages) {
    const sanitized = sanitizeShareMessage(raw, redactPaths, allowedRoots, opts.home)
    if (sanitized) safe.push(sanitized)
  }
  if (!safe.length) throw new Error('This conversation has no shareable messages yet.')
  let title = typeof session.title === 'string' ? session.title : 'Untitled'
  title = redactSensitive(title || 'Untitled')
  title = redactSharePaths(title, redactPaths) || 'Untitled'
  return { title, messages: safe, message_count: safe.length }
}

export interface ShareMeta { share_token: string; share_title: string; share_message_count: number; share_created_at: number; share_updated_at: number }

export class ShareStore {
  constructor(readonly dir: string, private readonly now: () => number) {}

  private pathFor(token: string): string {
    const t = token.trim()
    if (!SHARE_TOKEN_RE.test(t)) throw new Error('Invalid share token')
    return join(this.dir, `${t}.json`)
  }

  createOrRefresh(session: Session, snapshot: ShareSnapshot): ShareMeta {
    mkdirSync(this.dir, { recursive: true })
    const token = (session.share_token ?? '').trim() || randomBytes(18).toString('base64url')
    const now = this.now()
    const payload: Record<string, unknown> = {
      token, source_session_id: session.session_id, title: snapshot.title, messages: snapshot.messages, message_count: snapshot.message_count,
      created_at: now, updated_at: now, revoked_at: null,
    }
    const path = this.pathFor(token)
    if (existsSync(path)) {
      try {
        const existing = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (isDict(existing)) payload.created_at = existing.created_at || now
      } catch { /* malformed existing snapshot */ }
    }
    atomicWriteText(path, JSON.stringify(payload, null, 2), { mode: 0o600 })
    return { share_token: token, share_title: snapshot.title, share_message_count: snapshot.message_count, share_created_at: payload.created_at as number, share_updated_at: now }
  }

  /** The public payload, or null when missing/revoked. */
  load(token: string): Record<string, unknown> | null {
    let path: string
    try { path = this.pathFor(token) } catch { return null }
    if (!existsSync(path)) return null
    let payload: unknown
    try { payload = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
    if (!isDict(payload) || payload.revoked_at) return null
    // A snapshot taken before TAL-302 may still carry inline thinking; it leaves as prose only, like a new one.
    const messages = (Array.isArray(payload.messages) ? payload.messages : []).map((m: unknown) => {
      if (!isDict(m) || m.role !== 'assistant') return m
      const prose = normalizeAssistantDisplay(m)
      delete prose.reasoning
      return prose
    })
    const pub: Record<string, unknown> = { title: str(payload.title) || 'Untitled', messages, message_count: Math.trunc(Number(payload.message_count)) || messages.length }
    if (typeof payload.created_at === 'number') pub.created_at = payload.created_at
    if (typeof payload.updated_at === 'number') pub.updated_at = payload.updated_at
    return pub
  }

  revoke(session: Session): boolean {
    const token = (session.share_token ?? '').trim()
    if (!token) return false
    let path: string
    try { path = this.pathFor(token) } catch { return false }
    if (existsSync(path)) {
      let payload: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (isDict(parsed)) payload = parsed
      } catch { payload = {} }
      payload.revoked_at = this.now()
      atomicWriteText(path, JSON.stringify(payload, null, 2), { mode: 0o600 })
    }
    return true
  }
}
