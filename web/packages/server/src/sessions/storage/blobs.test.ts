import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { runBlobStoreConformance } from './blob-conformance.js'
import { LocalBlobStore, materializeAttachment, type BlobStore } from './blobs.js'
import { S3BlobStore } from './blobs-s3.js'
import { copyBlobs, runStorage } from '../../cli/storage.js'
import { loadConfig } from '../../config.js'
import { bootTestServer } from '../../test/harness.js'
import { FakeSidecar } from '../../sidecar/fake.js'
import { str } from '../../util.js'
import { ZipWriter } from '../../workspace/zip.js'

const temp = (name: string): string => mkdtempSync(join(tmpdir(), `talaria-blobs-${name}-`))

runBlobStoreConformance('local', () => {
  const root = temp('local')
  return Promise.resolve({
    store: new LocalBlobStore(() => root),
    downloads: () => 0,
    capped: () => Promise.resolve(new LocalBlobStore(() => root)),
    evicts: false,
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
  })
})

it('fails startup on an unknown blob store or an S3 store without a bucket, never falling back', () => {
  const home = temp('config')
  try {
    expect(loadConfig({ home, webRoot: home, env: {} }).blobs).toEqual({ kind: 'local' })
    expect(() => loadConfig({ home, webRoot: home, env: { TALARIA_BLOB_STORAGE: 'nas' } })).toThrow('Unknown TALARIA_BLOB_STORAGE="nas"; supported: local, s3')
    expect(() => loadConfig({ home, webRoot: home, env: { TALARIA_BLOB_STORAGE: 's3' } })).toThrow('TALARIA_BLOB_STORAGE=s3 needs TALARIA_BLOB_S3_BUCKET')
    expect(loadConfig({ home, webRoot: home, env: { TALARIA_BLOB_STORAGE: 's3', TALARIA_BLOB_S3_BUCKET: 'b', TALARIA_BLOB_S3_FORCE_PATH_STYLE: 'false' } }).blobs).toMatchObject({ kind: 's3', bucket: 'b', forcePathStyle: false, cacheMaxBytes: 2048 * 1024 * 1024 })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('refuses malformed copy-blobs arguments before touching any store', async () => {
  const warn = vi.fn()
  for (const args of [[], ['copy-blobs'], ['copy-blobs', '--from', 'local', '--to', 'local'], ['copy-blobs', '--from', 'disk', '--to', 's3'], ['other', '--from', 'local', '--to', 's3']]) {
    expect(await runStorage({ env: {}, webRoot: '/nonexistent', home: '/nonexistent', log: vi.fn(), warn }, args)).toBe(2)
  }
  expect(warn).toHaveBeenCalledWith('Usage: talaria-web storage copy-blobs --from <local|s3> --to <local|s3>')
})

// ── S3, against MinIO or any S3-compatible endpoint ──
const endpoint = (process.env.TALARIA_TEST_BLOB_ENDPOINT ?? '').trim()
// CI never passes without the S3 suite: a missing endpoint there is a configuration error, not a skip.
if (!endpoint && process.env.CI === 'true') throw new Error('TALARIA_TEST_BLOB_ENDPOINT must be set in CI; the S3 blob suite refuses to skip')
if (!endpoint) console.warn('[blobs.test] Skipping the S3 blob suite: set TALARIA_TEST_BLOB_ENDPOINT (and AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) to run it against MinIO.')

const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '' }
const admin = endpoint ? new S3Client({ endpoint, forcePathStyle: true, region: 'us-east-1', credentials }) : null
const bucket = `talaria-test-${randomBytes(6).toString('hex')}`
let bucketReady: Promise<unknown> | null = null
const ensureBucket = (): Promise<unknown> => (bucketReady ??= admin!.send(new CreateBucketCommand({ Bucket: bucket })))
async function objectKeys(prefix: string): Promise<string[]> {
  const out = await admin!.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
  return (out.Contents ?? []).map((item) => item.Key!).sort()
}
afterAll(async () => {
  if (!admin || !bucketReady) return
  for (let keys = await objectKeys(''); keys.length; keys = await objectKeys('')) {
    await admin.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }))
  }
  await admin.send(new DeleteBucketCommand({ Bucket: bucket }))
  admin.destroy()
})

async function s3Store(prefix: string, cacheDir: string, cacheMaxBytes = 64 * 1024 * 1024): Promise<S3BlobStore> {
  await ensureBucket()
  return new S3BlobStore({ endpoint, bucket, prefix, forcePathStyle: true, region: 'us-east-1', credentials, cacheDir, cacheMaxBytes })
}

describe.skipIf(!endpoint)(endpoint ? 'S3 blob store' : 'S3 blob store (skipped: TALARIA_TEST_BLOB_ENDPOINT is not set)', () => {
  runBlobStoreConformance('S3', async () => {
    const prefix = `conformance-${randomBytes(4).toString('hex')}`
    const state = temp('s3')
    const store = await s3Store(prefix, join(state, 'cache'))
    const send = vi.spyOn(store.client, 'send')
    return {
      store,
      downloads: () => send.mock.calls.filter(([command]) => command instanceof GetObjectCommand && Boolean(command.input.IfMatch)).length,
      capped: (maxBytes) => s3Store(prefix, join(state, 'capped'), maxBytes),
      evicts: true,
      cleanup: () => { rmSync(state, { recursive: true, force: true }) },
    }
  })

  it('hands a turn the uploaded bytes at a local path, serves them, and deletes them with the session', async () => {
    const prefix = `server-${randomBytes(4).toString('hex')}`
    await ensureBucket()
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({
      sidecar,
      env: { TALARIA_BLOB_STORAGE: 's3', TALARIA_BLOB_S3_ENDPOINT: endpoint, TALARIA_BLOB_S3_BUCKET: bucket, TALARIA_BLOB_S3_PREFIX: prefix, AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey },
    })
    try {
      const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
      const sid = ((await (await post('/api/session/new', {})).json()) as { session: { session_id: string } }).session.session_id
      const payload = `synthetic attachment ${randomBytes(8).toString('hex')}`
      const form = ['--b', 'Content-Disposition: form-data; name="session_id"', '', sid, '--b', 'Content-Disposition: form-data; name="file"; filename="notes.txt"', 'Content-Type: text/plain', '', payload, '--b--', ''].join('\r\n')
      const upload = (await (await s.get('/api/upload', { method: 'POST', body: form, headers: { 'content-type': 'multipart/form-data; boundary=b' } })).json()) as { path: string; filename: string }
      expect(upload.filename).toBe('notes.txt')
      expect(upload.path).toBe(join(s.deps.blobs.attachmentRoot(), sid, 'notes.txt'))
      expect(await objectKeys(`${prefix}/attachments/${sid}/`)).toEqual([`${prefix}/attachments/${sid}/notes.txt`])

      // The cached copy is gone (eviction, a restart): the turn must download it again before the Agent runs.
      rmSync(upload.path)
      let seen: { prompt: string; bytes: string } | null = null
      sidecar.respond('chat.start', (params) => {
        const prompt = JSON.stringify(params.user_message)
        seen = { prompt, bytes: existsSync(upload.path) ? readFileSync(upload.path, 'utf8') : '<missing>' }
        return { status: 'completed', messages: [...params.conversation_history, { role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'read it' }], final_response: 'read it', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 1000 }, model: 'test-model', provider: 'test', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }
      })
      const start = (await (await post('/api/chat/start', { session_id: sid, message: 'read the file', attachments: [{ path: upload.path, name: 'notes.txt', mime: 'text/plain' }] })).json()) as { stream_id: string }
      await s.sse(`/api/chat/stream?stream_id=${start.stream_id}`, (f) => f.event === 'stream_end')
      expect(seen).not.toBeNull()
      expect(seen!.prompt).toContain(upload.path)
      expect(seen!.bytes).toBe(payload)

      rmSync(upload.path)
      const raw = await s.get(`/api/file/raw?session_id=${sid}&path=notes.txt`)
      expect(raw.status).toBe(200)
      expect(await raw.text()).toBe(payload)

      expect((await post('/api/session/delete', { session_id: sid })).status).toBe(200)
      expect(await objectKeys(`${prefix}/attachments/${sid}/`)).toEqual([])
      expect(existsSync(upload.path)).toBe(false)
    } finally { await s.close() }
  })

  it('keeps extracted archive files on disk while storing each one', async () => {
    const prefix = `extract-${randomBytes(4).toString('hex')}`
    await ensureBucket()
    const s = await bootTestServer({ env: { TALARIA_BLOB_STORAGE: 's3', TALARIA_BLOB_S3_ENDPOINT: endpoint, TALARIA_BLOB_S3_BUCKET: bucket, TALARIA_BLOB_S3_PREFIX: prefix, AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey } })
    try {
      const sid = ((await (await s.get('/api/session/new', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json()) as { session: { session_id: string } }).session.session_id
      const chunks: Buffer[] = []
      const zip = new ZipWriter(new Writable({ write(chunk: Buffer, _enc, cb) { chunks.push(chunk); cb() } }))
      for (const [name, text] of [['hello.txt', 'Hello'], ['sub/nested.txt', 'Nested']] as const) await zip.addFile(name, Readable.from([Buffer.from(text)]), text.length)
      await zip.finish()
      const head = Buffer.from(['--b', 'Content-Disposition: form-data; name="session_id"', '', sid, '--b', 'Content-Disposition: form-data; name="file"; filename="demo.zip"', 'Content-Type: application/zip', '', ''].join('\r\n'))
      const res = await s.get('/api/upload/extract', { method: 'POST', body: Buffer.concat([head, Buffer.concat(chunks), Buffer.from('\r\n--b--\r\n')]), headers: { 'content-type': 'multipart/form-data; boundary=b' } })
      const body = (await res.json()) as { dest: string; files: string[] }
      expect(res.status, JSON.stringify(body)).toBe(200)
      expect(readFileSync(join(body.dest, 'hello.txt'), 'utf8')).toBe('Hello')
      expect(readFileSync(join(body.dest, 'sub', 'nested.txt'), 'utf8')).toBe('Nested')
      expect(await objectKeys(`${prefix}/attachments/${sid}/`)).toEqual([`${prefix}/attachments/${sid}/demo/hello.txt`, `${prefix}/attachments/${sid}/demo/sub/nested.txt`])
    } finally { await s.close() }
  })

  it('never writes or deletes through a cache directory replaced by a symlink', async () => {
    const state = temp('s3-symlink')
    const outside = temp('s3-outside')
    const store = await s3Store(`symlink-${randomBytes(4).toString('hex')}`, join(state, 'cache'))
    try {
      writeFileSync(join(outside, 'victim.txt'), 'outside')
      // A local writer (an Agent tool) swaps the session's cache directory for a link out of the cache.
      symlinkSync(outside, join(store.attachmentRoot(), 's2'))
      await store.put('attachments/s2/victim.txt', Buffer.from('uploaded'), { exclusive: true })
      expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('outside')
      // The download is refused rather than written through the link.
      await store.localPath('attachments/s2/victim.txt').catch(() => null)
      expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('outside')
      await store.delete('attachments/s2/victim.txt')
      await store.deletePrefix('attachments/s2/')
      expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('outside')
    } finally {
      await store.close()
      rmSync(state, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('copies a local attachment tree to S3, verifies it, and copies nothing on a re-run', async () => {
    const root = temp('copy-local')
    const state = temp('copy-s3')
    const files: Record<string, string> = { 's1/a.txt': 'alpha', 's1/tree/b.bin': randomBytes(1024).toString('base64'), 's2/é 日本.txt': 'unicode' }
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    const local: BlobStore = new LocalBlobStore(() => root)
    const prefix = `copy-${randomBytes(4).toString('hex')}`
    const remote = await s3Store(prefix, join(state, 'cache'))
    try {
      const log = vi.fn()
      expect(await copyBlobs(local, remote, log)).toEqual({ copied: 3, skipped: 0 })
      expect(await objectKeys(`${prefix}/`)).toEqual(Object.keys(files).map((rel) => `${prefix}/attachments/${rel}`).sort())
      for (const [rel, text] of Object.entries(files)) {
        const path = await remote.localPath(`attachments/${rel}`)
        expect(readFileSync(path, 'utf8')).toBe(text)
      }
      const send = vi.spyOn(remote.client, 'send')
      expect(await copyBlobs(local, remote, log)).toEqual({ copied: 0, skipped: 3 })
      // The re-run trusts the recorded SHA-256 and downloads nothing.
      expect(send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toEqual([])
      // The source is never deleted.
      for (const [rel, text] of Object.entries(files)) expect(readFileSync(join(root, rel), 'utf8')).toBe(text)
      // A changed source is copied again.
      writeFileSync(join(root, 's1/a.txt'), 'changed')
      expect(await copyBlobs(local, remote, log)).toEqual({ copied: 1, skipped: 2 })
      expect((await remote.stat('attachments/s1/a.txt'))?.size).toBe(7)
      await materializeAttachment(remote, join(remote.attachmentRoot(), 's1', 'a.txt'))
      expect(readFileSync(join(remote.attachmentRoot(), 's1', 'a.txt'), 'utf8')).toBe('changed')
    } finally {
      await remote.close()
      rmSync(root, { recursive: true, force: true })
      rmSync(state, { recursive: true, force: true })
    }
  })
})
