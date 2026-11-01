/** Chat attachment uploads: multipart parsing, the per-session inbox, and rollback receipts (Python `api/upload.py`). */
import { existsSync, mkdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { MIMEType } from 'node:util'
import { isWithin, resolvePathLikePython } from './paths.js'
import { attachmentKey, attachmentSessionName, BlobExists, BlobKeyRejected, localSignature, type BlobStat, type BlobStore } from '../sessions/storage/blobs.js'
import { extractArchive, type Extraction } from './extract.js'
import { mimeFor } from './media.js'
import { MAX_CHAT_ATTACHMENTS } from '@maudecode/talaria-web-contracts'

export interface MultipartFile { filename: string; body: Buffer }
/** `files` keeps the last part per field name; `parts` keeps every file part in order (repeated field names included). */
export interface MultipartResult { fields: Record<string, string>; files: Record<string, MultipartFile>; parts: MultipartFile[] }

/** Multipart delimiter lines with CRLF framing and legacy LF compatibility. */
export function parseMultipart(raw: Buffer, contentType: string): MultipartResult {
  let boundary: string | null
  try { boundary = new MIMEType(contentType).params.get('boundary') } catch { throw new Error('Invalid boundary in Content-Type') }
  if (!boundary || !/^[0-9A-Za-z'()+_,./:=? -]{0,69}[0-9A-Za-z'()+_,./:=?-]$/.test(boundary)) throw new Error('Invalid boundary in Content-Type')
  const delimiter = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = {}
  const files: Record<string, MultipartFile> = {}
  const fileParts: MultipartFile[] = []
  const parts = splitMultipart(raw, delimiter)
  for (const part of parts) {
    const crlf = part.indexOf('\r\n\r\n')
    const lf = part.indexOf('\n\n')
    const useCrlf = crlf >= 0 && (lf < 0 || crlf < lf)
    const sepIndex = useCrlf ? crlf : lf
    const sepLen = useCrlf ? 4 : 2
    if (sepIndex < 0) throw new Error('Invalid multipart part headers')
    const headerRaw = part.subarray(0, sepIndex)
    const body = part.subarray(sepIndex + sepLen)
    const headers = headerRaw.toString('utf8')
    const disp = /^content-disposition:\s*(.*)$/im.exec(headers)?.[1] ?? ''
    const nameM = /name="([^"]*)"/.exec(disp)
    const fileM = /filename="([^"]*)"/.exec(disp)
    if (!nameM) continue
    const name = nameM[1] ?? ''
    if (fileM) {
      files[name] = { filename: fileM[1] ?? '', body: Buffer.from(body) }
      fileParts.push(files[name])
    }
    else fields[name] = body.toString('utf8')
  }
  return { fields, files, parts: fileParts }
}

function splitMultipart(buf: Buffer, delimiter: Buffer): Buffer[] {
  const out: Buffer[] = []
  let start: number | null = null
  let framingLength = 2
  for (let idx = buf.indexOf(delimiter); idx >= 0; idx = buf.indexOf(delimiter, idx + delimiter.length)) {
    if (idx > 0 && buf[idx - 1] !== 0x0a) continue
    let end = idx + delimiter.length
    const closing = buf[end] === 0x2d && buf[end + 1] === 0x2d
    if (closing) end += 2
    while (buf[end] === 0x20 || buf[end] === 0x09) end += 1
    const newlineLength = buf[end] === 0x0d ? 2 : 1
    if (buf[end] === 0x0d && buf[end + 1] === 0x0a) end += 2
    else if (buf[end] === 0x0a) end += 1
    else if (!closing || end !== buf.length) continue
    if (start !== null) {
      // Use the preceding delimiter's newline style so LF framing preserves a payload's final CR.
      const partEnd = idx - (framingLength === 2 && buf[idx - 2] === 0x0d ? 2 : 1)
      if (partEnd < start) throw new Error('Invalid multipart framing')
      out.push(buf.subarray(start, partEnd))
    }
    if (closing) return out
    start = end
    framingLength = newlineLength
  }
  throw new Error('Incomplete multipart framing: missing closing delimiter')
}

export function sanitizeUploadName(filename: string): string {
  const safe = basename(filename).replace(/[^\w.-]/g, '_').slice(0, 200)
  if (!safe || safe.replace(/^\.+|\.+$/g, '') === '') throw new Error('Invalid filename')
  return safe
}

/**
 * A file receipt holds its key's etag; an extracted tree's receipt holds every file's. `local` holds the identity of each
 * file's local copy at upload, since a remote store's etag does not change when that copy is edited.
 */
interface Receipt { sessionId: string; key: string; isDir: boolean; etags: Map<string, string>; local: Map<string, string>; createdAt: number; rollingBack?: boolean }

const RECEIPT_TTL_MS = 60 * 60 * 1000

export class UploadInbox {
  private readonly receipts = new Map<string, Receipt>()

  /** `legacyRoot`: the local attachment directory, when a remote store replaced it; transcripts may still name it. */
  constructor(readonly blobs: BlobStore, private readonly legacyRoot: (() => string) | null = null, private readonly now: () => number = () => Date.now()) {}

  /** A path into the session's old local directory, as the same name in its current attachments; anything else unchanged. */
  rebase(sessionId: string, rel: string): string {
    if (!this.legacyRoot || !isAbsolute(rel)) return rel
    const legacy = resolvePathLikePython(join(this.legacyRoot(), attachmentSessionName(sessionId)))
    const resolved = resolvePathLikePython(rel)
    return resolved !== legacy && isWithin(resolved, legacy) ? relative(legacy, resolved) : rel
  }

  /** Python `_session_attachment_dir`: where the session's attachments are (or are materialized) on disk. */
  sessionDir(sessionId: string): string {
    const root = resolvePathLikePython(this.blobs.attachmentRoot())
    const dest = resolvePathLikePython(join(root, attachmentSessionName(sessionId)))
    if (dest !== root && !isWithin(dest, root)) throw new Error('Invalid attachment directory')
    return dest
  }

  /** Where `key`'s local copy is, without downloading it. */
  private localFile(sessionId: string, key: string): string {
    return join(this.sessionDir(sessionId), ...key.split('/').slice(2))
  }

  private registerReceipt(sessionId: string, key: string, isDir: boolean, etags: Map<string, string>): string {
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    for (const [k, value] of this.receipts) if (now - value.createdAt > RECEIPT_TTL_MS) this.receipts.delete(k)
    const local = new Map<string, string>()
    for (const k of etags.keys()) {
      const sig = localSignature(this.localFile(sessionId, k))
      if (sig) local.set(k, sig)
    }
    this.receipts.set(token, { sessionId, key, isDir, etags, local, createdAt: now })
    return token
  }

  /** The stored objects still match the receipt exactly: nothing replaced, added or removed since the upload. */
  private async unchanged(receipt: Receipt): Promise<boolean> {
    // A local copy still on disk must be the one written at upload; an evicted one has nothing left to protect.
    for (const [key, sig] of receipt.local) {
      const current = localSignature(this.localFile(receipt.sessionId, key))
      if (current !== null && current !== sig) return false
    }
    if (!receipt.isDir) return (await this.blobs.stat(receipt.key))?.etag === receipt.etags.get(receipt.key)
    let seen = 0
    for await (const item of this.blobs.list(receipt.key)) {
      if (receipt.etags.get(item.key) !== item.etag) return false
      seen += 1
    }
    return seen === receipt.etags.size
  }

  async rollback(sessionId: string, tokens: string[]): Promise<{ ok: boolean; rolled_back: number; failed: number }> {
    this.sessionDir(sessionId)
    let rolledBack = 0
    let failed = 0
    const now = this.now()
    for (const token of tokens) {
      const receipt = this.receipts.get(token)
      if (receipt?.sessionId !== sessionId || receipt.rollingBack) { failed += 1; continue }
      if (now - receipt.createdAt > RECEIPT_TTL_MS) { this.receipts.delete(token); failed += 1; continue }
      receipt.rollingBack = true
      try {
        if (!(await this.unchanged(receipt))) throw new Error('Upload target changed')
        if (receipt.isDir) await this.blobs.deletePrefix(receipt.key)
        else await this.blobs.delete(receipt.key)
      } catch {
        receipt.rollingBack = false
        failed += 1
        continue
      }
      this.receipts.delete(token)
      rolledBack += 1
    }
    return { ok: failed === 0, rolled_back: rolledBack, failed }
  }

  /** Store one upload with an exclusive put under a name free in the session's attachments. */
  async store(sessionId: string, filename: string, bytes: Buffer): Promise<{ filename: string; path: string; size: number; mime: string; is_image: boolean; rollback_token: string; named_in_prompt: true; max_attachments_per_message: number }> {
    const safeName = sanitizeUploadName(filename)
    this.sessionDir(sessionId)
    // Python `_upload_destination`: a name already in the inbox gets `-1`, `-2`, ... (every clipboard paste is
    // `image.png`); the 409 below is reserved for a duplicate that raced past this check.
    const stored = await uploadDestinationName(safeName, async (name) => Boolean(await this.blobs.stat(attachmentKey(sessionId, name))))
    const key = attachmentKey(sessionId, stored)
    const mime = guessMime(stored)
    let stat: BlobStat
    try {
      stat = await this.blobs.put(key, bytes, { contentType: mime, exclusive: true })
    } catch (error) {
      if (error instanceof BlobExists) throw new UploadConflict(`Upload destination already exists: ${safeName}`)
      if (error instanceof BlobKeyRejected) throw new UploadRejected('Upload destination rejected')
      throw error
    }
    const token = this.registerReceipt(sessionId, key, false, new Map([[key, stat.etag]]))
    // The response reports the name actually stored (Python `test_duplicate_upload_response_reports_actual_stored_filename`).
    // The server names every attached file in the turn's prompt (TAL-276) and keeps at most
    // MAX_CHAT_ATTACHMENTS per message, so clients send the bare draft and stage no more (TAL-635).
    return { filename: stored, path: await this.blobs.localPath(key), size: bytes.length, mime, is_image: mime.startsWith('image/'), rollback_token: token, named_in_prompt: true, max_attachments_per_message: MAX_CHAT_ATTACHMENTS }
  }

  /** Python `handle_upload_extract`: unpack into `<session inbox>/<stem>`, store every file, and return a tree receipt. */
  async extract(sessionId: string, filename: string, bytes: Buffer, cap: number): Promise<Extraction & { rollback_token: string }> {
    const inbox = this.sessionDir(sessionId)
    mkdirSync(inbox, { recursive: true })
    const prefixOf = (dir: string): string => `${attachmentKey(sessionId, ...relative(inbox, dir).split(sep))}/`
    const result = await extractArchive(bytes, filename, inbox, inbox, cap, async (dir) => {
      for await (const _ of this.blobs.list(prefixOf(dir))) return true
      return false
    })
    const prefix = prefixOf(result.dest)
    try {
      const etags = new Map<string, string>()
      // The archive lands in the local directory; a remote store keeps its own copy of every file.
      for (const file of result.files) {
        const key = attachmentKey(sessionId, ...file.split(sep))
        etags.set(key, (await this.blobs.commitLocal(key)).etag)
      }
      return { ...result, rollback_token: this.registerReceipt(sessionId, prefix, true, etags) }
    } catch (error) {
      try { await this.blobs.deletePrefix(prefix) } catch { /* ignore */ }
      throw error
    }
  }
}

export class UploadConflict extends Error {}

function* destinationNames(safeName: string): Generator<string> {
  yield safeName
  const ext = extname(safeName)
  const stem = safeName.slice(0, safeName.length - ext.length)
  for (let idx = 1; idx < 1000; idx += 1) yield `${stem}-${String(idx)}${ext}`
}

/** The first of `name`, `stem-1.ext` ... `stem-999.ext` that `taken` reports free. */
export async function uploadDestinationName(safeName: string, taken: (name: string) => Promise<boolean>): Promise<string> {
  for (const name of destinationNames(safeName)) if (!(await taken(name))) return name
  throw new UploadRejected('Too many uploads with the same filename')
}

export function uploadDestination(destDir: string, safeName: string): string {
  for (const name of destinationNames(safeName)) if (!existsSync(join(destDir, name))) return join(destDir, name)
  throw new UploadRejected('Too many uploads with the same filename')
}

export class UploadRejected extends Error {}

/** Python `mimetypes.guess_type` for the common cases plus the media map. */
export function guessMime(name: string): string {
  const fromMap = mimeFor(name)
  if (fromMap !== 'application/octet-stream' && !name.toLowerCase().endsWith('.ts') && !name.toLowerCase().endsWith('.tsx')) return fromMap
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'))
  const extra: Record<string, string> = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.py': 'text/x-python', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.xml': 'application/xml', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.ts': 'video/mp2t', '.tsx': 'application/octet-stream', '.heic': 'image/heic', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif' }
  return extra[ext] ?? 'application/octet-stream'
}
