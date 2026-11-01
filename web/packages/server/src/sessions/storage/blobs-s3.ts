/**
 * The S3-compatible `BlobStore` (TAL-1069): objects live in a bucket (AWS, MinIO, a NAS S3 endpoint), and `localPath`
 * downloads each one into `<cacheDir>/<key>` so the Agent always gets a real file.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, DeleteObjectsCommand,
  GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3'
import { ATTACHMENTS, BlobExists, blobKeyParts, type BlobPutOptions, type BlobStat, type BlobStore } from './blobs.js'

export const MULTIPART_THRESHOLD = 8 * 1024 * 1024

export interface S3BlobOptions {
  endpoint?: string | undefined
  bucket: string
  prefix?: string | undefined
  forcePathStyle: boolean
  region?: string | undefined
  /** Explicit keys from the server environment; otherwise the SDK's standard credential chain. */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  cacheDir: string
  cacheMaxBytes: number
  client?: S3Client
}

const stripEtag = (etag: string | undefined): string => (etag ?? '').replace(/^W\//, '').replace(/^"|"$/g, '')
const notFound = (error: unknown): boolean => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404
}
const preconditionFailed = (error: unknown): boolean => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e.name === 'PreconditionFailed' || e.$metadata?.httpStatusCode === 412
}

/** Chunks of exactly `size` bytes (the last one shorter) from any body. */
async function* chunked(body: Readable | Uint8Array, size: number): AsyncGenerator<Buffer> {
  if (body instanceof Uint8Array) {
    const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
    for (let at = 0; at < buf.length || at === 0; at += size) { yield buf.subarray(at, at + size); if (!buf.length) return }
    return
  }
  let pending: Buffer[] = []
  let held = 0
  for await (const chunk of body) {
    let data = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
    while (held + data.length >= size) {
      const take = size - held
      pending.push(data.subarray(0, take))
      yield Buffer.concat(pending)
      pending = []
      held = 0
      data = data.subarray(take)
    }
    if (data.length) { pending.push(data); held += data.length }
  }
  yield Buffer.concat(pending)
}

export class S3BlobStore implements BlobStore {
  readonly kind = 's3'
  readonly client: S3Client
  private readonly bucket: string
  private readonly prefix: string
  /** Cached keys in least-recently-used order, with their sizes. */
  private readonly cached = new Map<string, number>()
  private cachedBytes = 0
  private readonly downloads = new Map<string, Promise<string>>()
  private readonly cacheDir: string

  constructor(private readonly opts: S3BlobOptions) {
    this.bucket = opts.bucket
    const prefix = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '')
    this.prefix = prefix ? `${prefix}/` : ''
    this.client = opts.client ?? new S3Client({
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle,
      region: opts.region ?? 'us-east-1',
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      // S3-compatible servers (MinIO, NAS gateways) vary in their checksum support: send one only when required.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
    // ponytail: the cache starts empty each run (nothing on disk records which etag a file was), so a restart
    // re-downloads what turns touch; persist an index beside the cache if that ever costs too much.
    rmSync(opts.cacheDir, { recursive: true, force: true })
    mkdirSync(join(opts.cacheDir, ATTACHMENTS), { recursive: true })
    // Resolved once, so cache paths compare equal to the resolved paths the routes and the Agent use.
    this.cacheDir = realpathSync(opts.cacheDir)
  }

  /** Startup check: an unreachable or missing bucket fails startup instead of failing the first upload. */
  async verify(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
  }

  attachmentRoot(): string { return join(this.cacheDir, ATTACHMENTS) }
  private objectKey(key: string): string { return this.prefix + key }
  private cachePath(key: string): string { return join(this.cacheDir, ...blobKeyParts(key)) }
  private partialPath(): string { return join(this.cacheDir, '.partial', randomBytes(8).toString('hex')) }

  async put(key: string, body: Readable | Uint8Array, meta: BlobPutOptions = {}): Promise<BlobStat> {
    blobKeyParts(key)
    const hash = createHash('sha256')
    const parts = chunked(body, MULTIPART_THRESHOLD)
    const nextPart = async (): Promise<Buffer | null> => { const next = await parts.next(); return next.done ? null : next.value }
    const first = (await nextPart()) ?? Buffer.alloc(0)
    hash.update(first)
    const second = await nextPart()
    const common = { Bucket: this.bucket, Key: this.objectKey(key), ContentType: meta.contentType ?? 'application/octet-stream' }
    let etag: string
    let size = first.length
    let sha256: string | undefined
    try {
      if (!second) {
        sha256 = meta.sha256 ?? hash.digest('hex')
        const out = await this.client.send(new PutObjectCommand({ ...common, Body: first, ContentLength: first.length, Metadata: { sha256 }, ...(meta.exclusive ? { IfNoneMatch: '*' } : {}) }))
        etag = stripEtag(out.ETag)
      } else {
        sha256 = meta.sha256 ?? (body instanceof Uint8Array ? createHash('sha256').update(body).digest('hex') : undefined)
        const created = await this.client.send(new CreateMultipartUploadCommand({ ...common, ...(sha256 ? { Metadata: { sha256 } } : {}) }))
        const uploadId = created.UploadId!
        try {
          const done: { ETag: string; PartNumber: number }[] = []
          const send = async (chunk: Buffer): Promise<void> => {
            const PartNumber = done.length + 1
            const out = await this.client.send(new UploadPartCommand({ Bucket: this.bucket, Key: common.Key, UploadId: uploadId, PartNumber, Body: chunk, ContentLength: chunk.length }))
            done.push({ ETag: out.ETag!, PartNumber })
          }
          await send(first)
          for (let next: Buffer | null = second; next; next = await nextPart()) {
            if (!next.length) continue
            hash.update(next)
            size += next.length
            await send(next)
          }
          sha256 ??= hash.digest('hex')
          const out = await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: common.Key, UploadId: uploadId, MultipartUpload: { Parts: done }, ...(meta.exclusive ? { IfNoneMatch: '*' } : {}) }))
          etag = stripEtag(out.ETag)
        } catch (error) {
          await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: common.Key, UploadId: uploadId })).catch(() => undefined)
          throw error
        }
      }
    } catch (error) {
      if (meta.exclusive && preconditionFailed(error)) throw new BlobExists(key)
      throw error
    }
    // An upload the session is about to reference is written through, so its first turn needs no download.
    if (body instanceof Uint8Array) this.writeCache(key, body)
    else this.forget(key)
    return { size, etag, contentType: common.ContentType, modifiedAt: Date.now(), sha256 }
  }

  async get(key: string, range?: { start: number; end: number }): Promise<{ body: Readable; stat: BlobStat } | null> {
    blobKeyParts(key)
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), ...(range ? { Range: `bytes=${String(range.start)}-${String(range.end)}` } : {}) }))
      const total = /\/(\d+)$/.exec(out.ContentRange ?? '')?.[1]
      return {
        body: out.Body as Readable,
        stat: { size: total ? Number(total) : (out.ContentLength ?? 0), etag: stripEtag(out.ETag), contentType: out.ContentType, modifiedAt: out.LastModified?.getTime() ?? 0, sha256: out.Metadata?.sha256 },
      }
    } catch (error) {
      if (notFound(error)) return null
      throw error
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    blobKeyParts(key)
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }))
      return { size: out.ContentLength ?? 0, etag: stripEtag(out.ETag), contentType: out.ContentType, modifiedAt: out.LastModified?.getTime() ?? 0, sha256: out.Metadata?.sha256 }
    } catch (error) {
      if (notFound(error)) return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    blobKeyParts(key)
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }))
    this.forget(key)
  }

  async deletePrefix(prefix: string): Promise<number> {
    const parts = blobKeyParts(prefix, { prefix: true })
    if (parts.length < 2) throw new Error('deletePrefix needs a session prefix')
    let count = 0
    let batch: { Key: string }[] = []
    const flush = async (): Promise<void> => {
      if (!batch.length) return
      const out = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch, Quiet: true } }))
      if (out.Errors?.length) throw new Error(`Could not delete ${String(out.Errors.length)} blob(s) under ${prefix}: ${out.Errors[0]?.Message ?? out.Errors[0]?.Code ?? 'unknown error'}`)
      count += batch.length
      batch = []
    }
    for await (const { key } of this.list(prefix)) {
      batch.push({ Key: this.objectKey(key) })
      if (batch.length === 1000) await flush()
    }
    await flush()
    for (const key of [...this.cached.keys()]) if (key.startsWith(prefix)) this.forget(key)
    rmSync(join(this.cacheDir, ...parts), { recursive: true, force: true })
    return count
  }

  async *list(prefix: string): AsyncIterable<BlobStat & { key: string }> {
    blobKeyParts(prefix, { prefix: true })
    let token: string | undefined
    do {
      const out = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.objectKey(prefix), ContinuationToken: token }))
      for (const item of out.Contents ?? []) {
        if (!item.Key?.startsWith(this.prefix)) continue
        yield { key: item.Key.slice(this.prefix.length), size: item.Size ?? 0, etag: stripEtag(item.ETag), modifiedAt: item.LastModified?.getTime() ?? 0 }
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (token)
  }

  /** Concurrent calls for one key share one download; the bytes are checked against the etag they were asked for. */
  async localPath(key: string): Promise<string> {
    const path = this.cachePath(key)
    const pending = this.downloads.get(key)
    if (pending) return pending
    if (this.cached.has(key) && existsSync(path)) {
      this.remember(key, this.cached.get(key)!)
      return path
    }
    const download = this.download(key, path).finally(() => this.downloads.delete(key))
    this.downloads.set(key, download)
    return download
  }

  private async download(key: string, path: string): Promise<string> {
    const head = await this.stat(key)
    if (!head) {
      this.forget(key)
      return path
    }
    const partial = this.partialPath()
    mkdirSync(dirname(partial), { recursive: true })
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), IfMatch: `"${head.etag}"` }))
      let received = 0
      const count = new Transform({ transform(chunk: Buffer, _enc, done) { received += chunk.length; done(null, chunk) } })
      await pipeline(out.Body as Readable, count, createWriteStream(partial, { flags: 'wx' }))
      if (received !== head.size || stripEtag(out.ETag) !== head.etag) throw new Error(`Blob ${key} changed while it was downloading`)
      mkdirSync(dirname(path), { recursive: true })
      renameSync(partial, path)
    } catch (error) {
      rmSync(partial, { force: true })
      throw error
    }
    this.remember(key, head.size)
    return path
  }

  async commitLocal(key: string): Promise<BlobStat> {
    const path = this.cachePath(key)
    const stat = await this.put(key, createReadStream(path), { exclusive: true })
    this.remember(key, stat.size)
    return stat
  }

  private writeCache(key: string, body: Uint8Array): void {
    const path = this.cachePath(key)
    const partial = this.partialPath()
    try {
      mkdirSync(dirname(partial), { recursive: true })
      writeFileSync(partial, body, { flag: 'wx' })
      mkdirSync(dirname(path), { recursive: true })
      renameSync(partial, path)
      this.remember(key, body.byteLength)
    } catch {
      // The object is stored; a failed cache write only costs the next turn a download.
      rmSync(partial, { force: true })
      this.forget(key)
    }
  }

  /**
   * ponytail: least-recently-used eviction by total bytes; a file the Agent is still reading can be unlinked if newer
   * downloads pass the cap during its turn (an open descriptor keeps working, a reopen re-downloads). Pin a turn's
   * files if that shows up. The newest entry always stays, even alone over the cap.
   */
  private remember(key: string, size: number): void {
    this.cachedBytes -= this.cached.get(key) ?? 0
    this.cached.delete(key)
    this.cached.set(key, size)
    this.cachedBytes += size
    for (const oldest of this.cached.keys()) {
      if (this.cachedBytes <= this.opts.cacheMaxBytes || oldest === key) break
      if (!this.downloads.has(oldest)) this.forget(oldest)
    }
  }

  private forget(key: string): void {
    const size = this.cached.get(key)
    if (size !== undefined) {
      this.cached.delete(key)
      this.cachedBytes -= size
    }
    rmSync(this.cachePath(key), { force: true })
  }

  close(): Promise<void> {
    this.client.destroy()
    return Promise.resolve()
  }
}
