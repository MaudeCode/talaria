/** Chat attachment uploads: multipart parsing, the per-session inbox, and rollback receipts (Python `api/upload.py`). */
import { closeSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { writeFully } from '../fs/atomic.js'
import { basename, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { MIMEType } from 'node:util'
import { isWithin, resolvePathLikePython } from './paths.js'
import { openAnchoredCreateFd, rmtreeAnchored, unlinkAnchored, FileExistsError } from './fs.js'
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

interface Receipt { sessionId: string; path: string; isDir: boolean; dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; createdAt: number; rollingBack?: boolean }

const RECEIPT_TTL_MS = 60 * 60 * 1000

export class UploadInbox {
  private readonly receipts = new Map<string, Receipt>()

  constructor(readonly attachmentRoot: () => string, private readonly now: () => number = () => Date.now()) {}

  /** Python `_session_attachment_dir`. */
  sessionDir(sessionId: string): string {
    const root = resolvePathLikePython(this.attachmentRoot())
    const dest = resolvePathLikePython(join(root, (sessionId || 'session').replace(/[^\w.-]/g, '_').slice(0, 120)))
    if (dest !== root && !isWithin(dest, root)) throw new Error('Invalid attachment directory')
    return dest
  }

  registerReceipt(sessionId: string, target: string, isDir = false): string {
    const st = lstatSync(target, { bigint: true })
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    for (const [key, value] of this.receipts) if (now - value.createdAt > RECEIPT_TTL_MS) this.receipts.delete(key)
    this.receipts.set(token, { sessionId, path: target, isDir, dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, createdAt: now })
    return token
  }

  rollback(sessionId: string, tokens: string[]): { ok: boolean; rolled_back: number; failed: number } {
    const root = this.sessionDir(sessionId)
    let rolledBack = 0
    let failed = 0
    const now = this.now()
    for (const token of tokens) {
      const receipt = this.receipts.get(token)
      if (receipt?.sessionId !== sessionId || receipt.rollingBack) { failed += 1; continue }
      if (now - receipt.createdAt > RECEIPT_TTL_MS) { this.receipts.delete(token); failed += 1; continue }
      receipt.rollingBack = true
      try {
        let resolved = receipt.path
        try { resolved = realpathSync(receipt.path) } catch { /* lstat below fails too */ }
        let rootResolved = root
        try { rootResolved = realpathSync(root) } catch { /* keep */ }
        if (resolved !== rootResolved && !isWithin(resolved, rootResolved)) throw new Error('Invalid rollback target')
        const current = lstatSync(receipt.path, { bigint: true })
        if (current.dev !== receipt.dev || current.ino !== receipt.ino || current.size !== receipt.size || current.mtimeNs !== receipt.mtimeNs || current.ctimeNs !== receipt.ctimeNs) throw new Error('Upload target changed')
        if (receipt.isDir) rmtreeAnchored(root, receipt.path)
        else unlinkAnchored(root, receipt.path)
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

  /** Write one upload into the session inbox with an O_EXCL anchored create. */
  store(sessionId: string, filename: string, bytes: Buffer): { filename: string; path: string; size: number; mime: string; is_image: boolean; rollback_token: string; named_in_prompt: true; max_attachments_per_message: number } {
    const safeName = sanitizeUploadName(filename)
    const destDir = this.sessionDir(sessionId)
    mkdirSync(destDir, { recursive: true })
    // Python `_upload_destination`: a name already in the inbox gets `-1`, `-2`, ... (every clipboard paste is
    // `image.png`); the 409 below is reserved for a duplicate that raced past this check.
    const dest = uploadDestination(destDir, safeName)
    let fd: number
    try {
      fd = openAnchoredCreateFd(destDir, dest)
    } catch (error) {
      if (error instanceof FileExistsError) throw new UploadConflict(`Upload destination already exists: ${safeName}`)
      throw new UploadRejected('Upload destination rejected')
    }
    try {
      writeFully(fd, bytes)
    } finally {
      closeSync(fd)
    }
    let token: string
    try {
      token = this.registerReceipt(sessionId, dest)
    } catch (error) {
      try { unlinkAnchored(destDir, dest) } catch { /* ignore */ }
      throw error
    }
    // The response reports the name actually stored (Python `test_duplicate_upload_response_reports_actual_stored_filename`).
    const stored = basename(dest)
    const mime = guessMime(stored)
    // The server names every attached file in the turn's prompt (TAL-276) and keeps at most
    // MAX_CHAT_ATTACHMENTS per message, so clients send the bare draft and stage no more (TAL-635).
    return { filename: stored, path: dest, size: bytes.length, mime, is_image: mime.startsWith('image/'), rollback_token: token, named_in_prompt: true, max_attachments_per_message: MAX_CHAT_ATTACHMENTS }
  }
}

export class UploadConflict extends Error {}

export function uploadDestination(destDir: string, safeName: string): string {
  const dest = join(destDir, safeName)
  if (!existsSync(dest)) return dest
  const ext = extname(safeName)
  const stem = safeName.slice(0, safeName.length - ext.length)
  for (let idx = 1; idx < 1000; idx += 1) {
    const candidate = join(destDir, `${stem}-${String(idx)}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
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
