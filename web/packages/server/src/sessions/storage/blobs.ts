/* eslint-disable @typescript-eslint/require-await -- The local adapter's file operations are synchronous behind the async port, so errors still reject. */
/**
 * Blob storage for chat attachments (TAL-1069): one port, selected by `TALARIA_BLOB_STORAGE` independently of the
 * session `StorageBackend`. Keys are `attachments/<sanitized sid>/<name>`. Every adapter also keeps a local directory
 * (`attachmentRoot()`) where `localPath` puts a real file the Agent, the raw/media routes and shares can open.
 */
import { closeSync, createReadStream, fstatSync, lstatSync, mkdirSync, readdirSync, rmSync, type BigIntStats } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { writeFully } from '../../fs/atomic.js'
import { isWithin, resolvePathLikePython } from '../../workspace/paths.js'
import { FileExistsError, openAnchoredCreateFd, openAnchoredFd, rmtreeAnchored, unlinkAnchored } from '../../workspace/fs.js'

export interface BlobStat {
  size: number
  /** Changes whenever the stored bytes may have changed; upload receipts compare it. */
  etag: string
  contentType?: string | undefined
  modifiedAt: number
  /** Hex SHA-256 when the adapter recorded one at write time. */
  sha256?: string | undefined
}
export interface BlobPutOptions {
  contentType?: string | undefined
  sha256?: string | undefined
  /** Refuse with `BlobExists` instead of replacing an existing object. */
  exclusive?: boolean | undefined
}

export interface BlobStore {
  readonly kind: string
  put(key: string, body: Readable | Uint8Array, meta?: BlobPutOptions): Promise<BlobStat>
  /** `range` is inclusive at both ends, like an HTTP byte range. */
  get(key: string, range?: { start: number; end: number }): Promise<{ body: Readable; stat: BlobStat } | null>
  stat(key: string): Promise<BlobStat | null>
  delete(key: string): Promise<void>
  /** `prefix` names at least one session: `attachments/<sid>/`. */
  deletePrefix(prefix: string): Promise<number>
  list(prefix: string): AsyncIterable<BlobStat & { key: string }>
  /** A real file path with the object's bytes; the path does not exist when the object does not. */
  localPath(key: string): Promise<string>
  /** Store the file a local writer (archive extraction) left at `localPath(key)`. */
  commitLocal(key: string): Promise<BlobStat>
  /** The directory `localPath` maps `attachments/` into. */
  attachmentRoot(): string
  close(): Promise<void>
}

export const ATTACHMENTS = 'attachments'
export class BlobExists extends Error {}
/** A key whose local path the anchored walk refused (a symlinked component, a path outside the root). */
export class BlobKeyRejected extends Error {}

/** The upload inbox's session directory name, unchanged since the Python server. */
export function attachmentSessionName(sid: string): string {
  return (sid || 'session').replace(/[^\w.-]/g, '_').slice(0, 120)
}
export const attachmentPrefix = (sid: string): string => `${ATTACHMENTS}/${attachmentSessionName(sid)}/`
export const attachmentKey = (sid: string, ...names: string[]): string => attachmentPrefix(sid) + names.join('/')

/** The segments of a key, or of a prefix (trailing `/`), refusing anything that could leave its namespace. */
export function blobKeyParts(key: string, opts: { prefix?: boolean } = {}): string[] {
  const body = opts.prefix ? key.replace(/\/$/, '') : key
  if (opts.prefix && !key.endsWith('/')) throw new BlobKeyRejected(`Blob prefix must end with /: ${key}`)
  const parts = body.split('/')
  if (parts[0] !== ATTACHMENTS || parts.some((p) => !p || p === '.' || p === '..' || p.includes('\0') || p.includes('\\'))) throw new BlobKeyRejected(`Invalid blob key: ${key}`)
  if (!opts.prefix && parts.length < 3) throw new BlobKeyRejected(`Invalid blob key: ${key}`)
  return parts
}

/** The key a local path under `root` stands for, or null when it is outside. */
export function blobKeyForPath(root: string, path: string): string | null {
  if (!isWithin(path, root) || path === root) return null
  const key = [ATTACHMENTS, ...relative(root, path).split(sep)].join('/')
  try { blobKeyParts(key) } catch { return null }
  return key
}

/** Put the stored object an attachment path names on disk; a path outside the attachment directory is left alone. */
export async function materializeAttachment(blobs: BlobStore, path: string): Promise<void> {
  if (!isAbsolute(path)) return
  const key = blobKeyForPath(blobs.attachmentRoot(), resolvePathLikePython(path))
  if (key) await blobs.localPath(key)
}

/** ponytail: earlier turns' attachments are restored newest first up to this many bytes per turn; size it from the cache cap if that ever needs tuning. */
export const HISTORY_ATTACHMENT_BUDGET = 256 * 1024 * 1024

/**
 * A turn's files on disk: every attachment it sends, then those of earlier turns, newest first, within
 * `HISTORY_ATTACHMENT_BUDGET`, since the Agent may reopen a path its history names. Only the current ones may fail.
 */
export async function materializeTurnAttachments(blobs: BlobStore, current: string[], earlier: string[]): Promise<void> {
  await Promise.all(current.map((path) => materializeAttachment(blobs, path)))
  let budget = HISTORY_ATTACHMENT_BUDGET
  for (const path of new Set(earlier)) {
    if (current.includes(path) || !isAbsolute(path)) continue
    try {
      const key = blobKeyForPath(blobs.attachmentRoot(), resolvePathLikePython(path))
      const stat = key ? await blobs.stat(key) : null
      if (!key || !stat || stat.size > budget) continue
      budget -= stat.size
      await blobs.localPath(key)
    } catch { /* an earlier file stays missing, as it would be on disk */ }
  }
}

/** The identity the upload inbox's rollback receipts always compared: inode, size and both change times. */
const signature = (st: BigIntStats): string => `${String(st.dev)}:${String(st.ino)}:${String(st.size)}:${String(st.mtimeNs)}:${String(st.ctimeNs)}`
/** The identity of the file at `path` (not followed if a link), or null when nothing is there. */
export function localSignature(path: string): string | null {
  try { return signature(lstatSync(path, { bigint: true })) } catch { return null }
}
const statOf = (st: BigIntStats): BlobStat => ({ size: Number(st.size), etag: signature(st), modifiedAt: Number(st.mtimeMs) })

/** Today's attachment directory, byte for byte: `<root>/<sid>/<name>`, written with anchored exclusive creates. */
export class LocalBlobStore implements BlobStore {
  readonly kind = 'local'
  constructor(private readonly root: () => string) {}

  attachmentRoot(): string { return resolvePathLikePython(this.root()) }

  /** The session directory anchors every walk, as the upload inbox always did. */
  private locate(parts: string[]): { root: string; anchor: string | null; path: string } {
    const root = this.attachmentRoot()
    if (parts.length < 2) return { root, anchor: null, path: root }
    const anchor = resolvePathLikePython(join(root, parts[1]!))
    if (anchor !== root && !isWithin(anchor, root)) throw new BlobKeyRejected('Invalid attachment directory')
    return { root, anchor, path: parts.length > 2 ? join(anchor, ...parts.slice(2)) : anchor }
  }
  private file(key: string): { anchor: string; path: string } {
    const { anchor, path } = this.locate(blobKeyParts(key))
    return { anchor: anchor!, path }
  }

  async put(key: string, body: Readable | Uint8Array, meta: BlobPutOptions = {}): Promise<BlobStat> {
    const { anchor, path } = this.file(key)
    mkdirSync(anchor, { recursive: true })
    // ponytail: a replacement unlinks then creates, so a crash between them loses the old bytes; only the offline
    // copy command and tests replace, the upload inbox always writes exclusively.
    if (!meta.exclusive) await this.delete(key)
    let fd: number
    try {
      fd = openAnchoredCreateFd(anchor, path)
    } catch (error) {
      if (error instanceof FileExistsError) throw new BlobExists(key)
      throw new BlobKeyRejected(`Blob destination rejected: ${key}`)
    }
    try {
      try {
        if (body instanceof Uint8Array) writeFully(fd, body)
        else for await (const chunk of body) writeFully(fd, typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Uint8Array)
      } finally { closeSync(fd) }
    } catch (error) {
      try { unlinkAnchored(anchor, path) } catch { /* already gone */ }
      throw error
    }
    return statOf(lstatSync(path, { bigint: true }))
  }

  async get(key: string, range?: { start: number; end: number }): Promise<{ body: Readable; stat: BlobStat } | null> {
    const { anchor, path } = this.file(key)
    let fd: number
    try { fd = openAnchoredFd(anchor, path, { wantDir: false }) } catch { return null }
    const st = fstatSync(fd, { bigint: true })
    if (!st.isFile()) { closeSync(fd); return null }
    return { body: createReadStream('', { fd, ...(range ? { start: range.start, end: range.end } : {}) }), stat: statOf(st) }
  }

  async stat(key: string): Promise<BlobStat | null> {
    const { path } = this.file(key)
    try { return statOf(lstatSync(path, { bigint: true })) } catch { return null }
  }

  async delete(key: string): Promise<void> {
    const { anchor, path } = this.file(key)
    try { unlinkAnchored(anchor, path) } catch (error) { if (lstatExists(path)) throw error }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const parts = blobKeyParts(prefix, { prefix: true })
    if (parts.length < 2) throw new BlobKeyRejected('deletePrefix needs a session prefix')
    const count = [...this.walk(prefix)].length
    // A whole session goes the way session delete always removed it (a symlinked session directory loses only the
    // link); a subtree goes through the anchored walk.
    if (parts.length === 2) {
      rmSync(join(this.attachmentRoot(), parts[1]!), { recursive: true, force: true })
      return count
    }
    const { anchor, path } = this.locate(parts)
    try { rmtreeAnchored(anchor!, path) } catch (error) { if (lstatExists(path)) throw error }
    return count
  }

  async *list(prefix: string): AsyncIterable<BlobStat & { key: string }> {
    yield* this.walk(prefix)
  }

  private *walk(prefix: string): Generator<BlobStat & { key: string }> {
    const parts = blobKeyParts(prefix, { prefix: true })
    const { root, path } = this.locate(parts)
    const stack = [path]
    while (stack.length) {
      const dir = stack.pop()!
      let names: string[]
      try { names = readdirSync(dir) } catch { continue }
      for (const name of names.sort()) {
        const child = join(dir, name)
        let st: BigIntStats
        try { st = lstatSync(child, { bigint: true }) } catch { continue }
        if (st.isDirectory()) stack.push(child)
        else if (st.isFile()) {
          const key = blobKeyForPath(root, child)
          if (key) yield { key, ...statOf(st) }
        }
      }
    }
  }

  async localPath(key: string): Promise<string> { return this.file(key).path }

  async commitLocal(key: string): Promise<BlobStat> {
    const st = await this.stat(key)
    if (!st) throw new Error(`Nothing to commit at ${key}`)
    return st
  }

  async close(): Promise<void> { /* nothing held */ }
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

/** `HERMES_WEBUI_ATTACHMENT_DIR`, else `<stateDir>/attachments`: the local adapter's directory. */
export function localAttachmentRoot(env: Record<string, string | undefined>, stateDir: string, home: string): string {
  const override = (env.HERMES_WEBUI_ATTACHMENT_DIR ?? '').trim()
  return resolvePathLikePython(override ? override.replace(/^~(?=$|\/)/, home) : join(stateDir, 'attachments'))
}

/** The configured store; S3 loads its SDK only when selected and must reach its bucket before startup continues. */
export async function createBlobStore(config: import('../../config.js').ServerConfig, localRoot: () => string): Promise<BlobStore> {
  const blobs = config.blobs
  if (blobs.kind === 'local') return new LocalBlobStore(localRoot)
  const { S3BlobStore } = await import('./blobs-s3.js')
  const env = config.env
  const accessKeyId = (env.AWS_ACCESS_KEY_ID ?? '').trim()
  const secretAccessKey = (env.AWS_SECRET_ACCESS_KEY ?? '').trim()
  const store = new S3BlobStore({
    ...blobs,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) } } : {}),
  })
  try { await store.verify() } catch (error) {
    await store.close()
    throw new Error(`TALARIA_BLOB_STORAGE=s3: cannot reach bucket ${JSON.stringify(blobs.bucket)}${blobs.endpoint ? ` at ${blobs.endpoint}` : ''}: ${(error as Error).name}: ${(error as Error).message}`)
  }
  return store
}
