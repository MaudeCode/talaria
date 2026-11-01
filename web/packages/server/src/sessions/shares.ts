import { str } from '../util.js'
/**
 * Public share snapshots (Python `api/shares.py`): sanitized read-only copies
 * of a conversation under `shares/<token>.json`. Only user/assistant prose is
 * published; credentials and local paths are always redacted; local MEDIA:
 * references become inline images only when they resolve inside an allowed
 * root and pass the image allow-list.
 */
import { closeSync, fstatSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, resolve } from 'node:path'
import type { DocumentBackend } from './storage/backend.js'
import { readDocument } from './storage/document.js'
import { redactSensitive } from '../redact.js'
import { expandHome, isWithin, resolvePathLikePython } from '../workspace/paths.js'
import { openAnchoredFd, readFdUpTo } from '../workspace/fs.js'
import type { Session } from './session.js'
import { normalizeAssistantDisplay } from './merge.js'

const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/
const SHARE_MEDIA_RE = /MEDIA:(?!https?:\/\/)([^\s)\]>]+)/g
const SHARE_EMBED_MAX_BYTES = 512 * 1024
const ALLOWED_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const PLACEHOLDER = '[*Local attachment omitted from public share*]'
/**
 * Content-supplied inline `data:` URIs never reach a public share: their bytes are opaque to the credential
 * redactor, and an image that renders hides whatever follows a valid header. Only `embedShareMedia` output, which
 * runs after this pass, may carry one. Every pattern consumes its whole match or stops at a delimiter the next
 * opener needs, and the unbounded ones run only up to their last closer, so each scan stays linear.
 */
// A whole markdown image with a data: destination, including the <angle> form and a title.
const MD_DATA_IMAGE_RE = /!\[(?:[^\]!]|!(?!\[))*\]\(\s*(?:<\s*)?data:(?:[^()\n]|\([^()\n]*\))*\)/gi
// The renderer's looser image rule: up to the first ")" across newlines.
const MD_DATA_IMAGE_LOOSE_RE = /!\[(?:[^\]!]|!(?!\[))*\]\(data:image\/[^)]*\)/gi
// A raw or entity-escaped <img> tag, ended only at ">" or "&gt;" like the renderer's own tag rule.
const IMG_TAG_RE = /(?:<|&lt;)\s*img\b(?:[^>&]|&(?!gt;))*(?:>|&gt;)/gi
// Quoted values of text-only attributes: "metadata:" in an alt keeps its https image.
const IMG_TEXT_ATTR_RE = /(?<![\w:-])(?:alt|title|aria-label|aria-description)\s*=\s*(?:"[^"]*"|'[^']*')/gi
// A data: that starts a URI, even split by whitespace (the browser strips it), anywhere in a tag.
const DATA_URI_START_RE = /\bdata:\s*(?=[a-z0-9!#$&^_.+-]+\/|[;,])/i
// Catch-all: a URI-shaped data: through the end of its token. Prose such as "data: 5 rows" stays.
const DATA_URI_RE = /\bdata:(?=[a-z0-9!#$&^_.+-]+\/|[;,])[^\s<>()[\]`]*/gi
/**
 * Leading-byte signatures: `magic` at offset `at` (default 0), and when `brands` is set, one of them at bytes 8-12
 * (the WebP form type, or the ISO-BMFF `ftyp` major brand). The feedback brands match Relay's `matchesAttachmentType`.
 */
const IMAGE_MAGIC: Record<string, { magic: Buffer; at?: number; brands?: readonly string[] }> = {
  'image/png': { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  'image/jpeg': { magic: Buffer.from([0xff, 0xd8, 0xff]) },
  'image/gif': { magic: Buffer.from('GIF8') },
  'image/webp': { magic: Buffer.from('RIFF'), brands: ['WEBP'] },
  'image/heic': { magic: Buffer.from('ftyp'), at: 4, brands: ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'] },
  'video/mp4': { magic: Buffer.from('ftyp'), at: 4, brands: ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'] },
  'video/quicktime': { magic: Buffer.from('ftyp'), at: 4, brands: ['qt  '] },
  'video/webm': { magic: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) },
}

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

/** Whether the bytes start with the signature of `mime`; shared by public shares and feedback attachments. */
export function checkImageMagic(data: Buffer, mime: string): boolean {
  const signature = IMAGE_MAGIC[mime]
  const at = signature?.at ?? 0
  if (!signature || !data.subarray(at, at + signature.magic.length).equals(signature.magic)) return false
  return !signature.brands || (data.length >= 12 && signature.brands.includes(data.subarray(8, 12).toString('latin1')))
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
    // The file can grow after fstat: read one byte past the cap and refuse any overflow rather than the whole file.
    const data = readFdUpTo(fd, SHARE_EMBED_MAX_BYTES + 1)
    return data.length > SHARE_EMBED_MAX_BYTES ? null : data
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** Applies `re` only up to the end of the last `closer`, so every opener finds one and unclosed runs stay linear. */
function replaceBeforeLast(text: string, closers: string[], re: RegExp, replace: (match: string) => string): string {
  const cut = Math.max(...closers.map((c) => { const at = text.lastIndexOf(c); return at < 0 ? 0 : at + c.length }))
  return cut ? text.slice(0, cut).replace(re, replace) + text.slice(cut) : text
}

/** Replaces every content-supplied inline data: URI with the placeholder. Never decodes a payload. */
function omitInlineData(text: string): string {
  if (!/data:/i.test(text)) return text
  let out = replaceBeforeLast(text, ['>', '&gt;', '&GT;'], IMG_TAG_RE, (tag) =>
    DATA_URI_START_RE.test(tag) || /data:/i.test(tag.replace(IMG_TEXT_ATTR_RE, '')) ? PLACEHOLDER : tag)
  out = out.replace(MD_DATA_IMAGE_RE, PLACEHOLDER)
  out = replaceBeforeLast(out, [')'], MD_DATA_IMAGE_LOOSE_RE, () => PLACEHOLDER)
  out = out.replace(SHARE_MEDIA_RE, (whole, ref: string) => (/^data:/i.test(ref) ? PLACEHOLDER : whole))
  return out.replace(DATA_URI_RE, PLACEHOLDER)
}

/** The share-only pipeline every published string passes through: credentials, inline data, then local paths. */
function sanitizeShareText(text: string, redactPaths: string[], embed: (text: string) => string = (t) => t): string {
  return redactSharePaths(embed(omitInlineData(redactSensitive(text))), redactPaths)
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
  text = sanitizeShareText(text, redactPaths, (t) => embedShareMedia(t, allowedRoots, home))
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
  const title = sanitizeShareText((typeof session.title === 'string' && session.title) || 'Untitled', redactPaths) || 'Untitled'
  return { title, messages: safe, message_count: safe.length }
}

export interface ShareMeta { share_token: string; share_title: string; share_message_count: number; share_created_at: number; share_updated_at: number }

export class ShareStore {
  constructor(private readonly documents: DocumentBackend, private readonly now: () => number) {}

  private validate(token: string): string {
    const t = token.trim()
    if (!SHARE_TOKEN_RE.test(t)) throw new Error('Invalid share token')
    return t
  }

  async createOrRefresh(session: Session, snapshot: ShareSnapshot, persistOwner?: (meta: ShareMeta) => Promise<void>): Promise<ShareMeta> {
    let token = (session.share_token ?? '').trim() || randomBytes(18).toString('base64url')
    const now = this.now()
    const payload: Record<string, unknown> = {
      token, source_session_id: session.session_id, title: snapshot.title, messages: snapshot.messages, message_count: snapshot.message_count,
      created_at: now, updated_at: now, revoked_at: null,
    }
    this.validate(token)
    let current = await readDocument(this.documents, 'shares', token, { replaceInvalid: true })
    // A failed ownership-clear can leave a revoked token on the session. Never publish it again.
    if (isDict(current?.value) && current.value.revoked_at) {
      token = randomBytes(18).toString('base64url')
      payload.token = token
      current = null
    }
    if (isDict(current?.value)) payload.created_at = current.value.created_at || now
    const meta = { share_token: token, share_title: snapshot.title, share_message_count: snapshot.message_count, share_created_at: payload.created_at as number, share_updated_at: now }
    // Persist the owner before making bytes readable, so even a lost publication acknowledgement is revocable.
    await persistOwner?.(meta)
    await this.documents.put('shares', token, payload, current?.revision ?? null)
    return meta
  }

  /** The public payload, or null when missing/revoked. */
  async load(token: string): Promise<Record<string, unknown> | null> {
    let payload: unknown
    try { payload = (await this.documents.get('shares', this.validate(token)))?.value } catch { return null }
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

  async revoke(session: Session): Promise<boolean> {
    const token = (session.share_token ?? '').trim()
    if (!token) return false
    try { this.validate(token) } catch { return false }
    const current = await readDocument(this.documents, 'shares', token, { replaceInvalid: true })
    if (current) {
      const payload = isDict(current.value) ? current.value : {}
      payload.revoked_at = this.now()
      await this.documents.put('shares', token, payload, current.revision)
    }
    return true
  }
}
