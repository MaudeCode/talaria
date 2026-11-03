import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, UploadPartCommand, type S3Client,
} from '@aws-sdk/client-s3'
import { materializeTurnAttachments } from './blobs.js'
import { S3BlobStore } from './blobs-s3.js'

// Bytes fed to every SHA-256 the adapter computes.
const hashed = vi.hoisted(() => ({ bytes: 0 }))
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>()
  return {
    ...actual,
    createHash: (algorithm: string) => {
      const hash = actual.createHash(algorithm)
      const update = hash.update.bind(hash)
      hash.update = ((data: Buffer) => { hashed.bytes += data.length; return update(data) }) as typeof hash.update
      return hash
    },
  }
})

/** An in-memory bucket behind `S3Client.send`, counting HEAD requests and how many are in flight at once. */
function fakeS3(): { client: S3Client; heads: string[]; maxInFlight: () => number } {
  const objects = new Map<string, { body: Buffer; etag: string }>()
  const uploads = new Map<string, Buffer[]>()
  const heads: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  let etags = 0
  const store = (key: string, body: Buffer): { ETag: string } => {
    const etag = `etag-${String(++etags)}`
    objects.set(key, { body, etag })
    return { ETag: `"${etag}"` }
  }
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof PutObjectCommand) return store(command.input.Key!, command.input.Body as Buffer)
    if (command instanceof CreateMultipartUploadCommand) { uploads.set(command.input.Key!, []); return { UploadId: command.input.Key } }
    if (command instanceof UploadPartCommand) { uploads.get(command.input.UploadId!)!.push(command.input.Body as Buffer); return { ETag: '"part"' } }
    if (command instanceof CompleteMultipartUploadCommand) return store(command.input.Key!, Buffer.concat(uploads.get(command.input.UploadId!)!))
    if (command instanceof HeadObjectCommand) {
      heads.push(command.input.Key!)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      const found = objects.get(command.input.Key!)
      if (!found) throw Object.assign(new Error('NotFound'), { name: 'NotFound' })
      return { ContentLength: found.body.length, ETag: `"${found.etag}"`, Metadata: {} }
    }
    if (command instanceof GetObjectCommand) {
      const found = objects.get(command.input.Key!)!
      return { Body: Readable.from([found.body]), ETag: `"${found.etag}"`, ContentLength: found.body.length }
    }
    throw new Error(`Unexpected S3 command ${(command as object).constructor.name}`)
  }
  return { client: { send, destroy: () => undefined } as unknown as S3Client, heads, maxInFlight: () => maxInFlight }
}

let dir: string
let s3: ReturnType<typeof fakeS3>
let store: S3BlobStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'talaria-blobs-fake-s3-'))
  s3 = fakeS3()
  store = new S3BlobStore({ bucket: 'b', forcePathStyle: true, cacheDir: join(dir, 'cache'), cacheMaxBytes: 64 * 1024 * 1024, client: s3.client })
})
afterEach(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }) })

it('restores earlier turns\' attachments without a HEAD for cached files and with one concurrent HEAD per uncached file', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `f${String(i)}.txt`)
  const paths = names.map((name) => join(store.attachmentRoot(), 's1', name))
  // An in-memory put is written through to the cache.
  for (const name of names) await store.put(`attachments/s1/${name}`, Buffer.from(`cached ${name}`))
  await materializeTurnAttachments(store, [], paths)
  expect(s3.heads).toEqual([])

  // A streamed put is not cached: every earlier file must come back from the bucket.
  for (const name of names) await store.put(`attachments/s1/${name}`, Readable.from([Buffer.from(`remote ${name}`)]))
  await materializeTurnAttachments(store, [], paths)
  expect([...s3.heads].sort()).toEqual(names.map((name) => `attachments/s1/${name}`).sort())
  expect(s3.maxInFlight()).toBe(8)
  for (const [i, path] of paths.entries()) expect(readFileSync(path, 'utf8')).toBe(`remote ${names[i]!}`)
})

it('hashes a multipart upload once, and not at all when its SHA-256 is given', async () => {
  const big = Buffer.alloc(9 * 1024 * 1024 + 17, 7)
  hashed.bytes = 0
  const put = await store.put('attachments/s1/big.bin', big)
  expect(hashed.bytes).toBe(big.length)

  hashed.bytes = 0
  await store.put('attachments/s1/known.bin', Readable.from([big]), { sha256: put.sha256 })
  expect(hashed.bytes).toBe(0)
})
