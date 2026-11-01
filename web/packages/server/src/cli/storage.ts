/**
 * `talaria-web storage copy-blobs --from <local|s3> --to <local|s3>` (TAL-1069): copy every chat attachment between
 * blob stores while the server is stopped. Each object is verified by size and SHA-256; a re-run copies only what is
 * missing or different, and the source is never deleted.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { loadBlobConfig, loadConfig, type ServerConfig } from '../config.js'
import { ATTACHMENTS, createBlobStore, localAttachmentRoot, type BlobStore } from '../sessions/storage/blobs.js'
import { guessMime } from '../workspace/upload.js'
import { loadStartupEnv } from './dotenv.js'

export interface StorageCliContext { env: Record<string, string | undefined>; webRoot: string; home: string; log: (line: string) => void; warn: (line: string) => void }

const USAGE = 'Usage: talaria-web storage copy-blobs --from <local|s3> --to <local|s3>'
const KINDS = new Set(['local', 's3'])

async function digest(store: BlobStore, key: string): Promise<{ sha256: string; size: number } | null> {
  const got = await store.get(key)
  if (!got) return null
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of got.body) {
    hash.update(chunk as Buffer)
    size += (chunk as Buffer).length
  }
  return { sha256: hash.digest('hex'), size }
}

/** Copy every attachment object, skipping one the destination already holds with the same bytes. */
export async function copyBlobs(from: BlobStore, to: BlobStore, log: (line: string) => void): Promise<{ copied: number; skipped: number }> {
  let copied = 0
  let skipped = 0
  for await (const item of from.list(`${ATTACHMENTS}/`)) {
    const source = await digest(from, item.key)
    if (!source) continue
    const existing = await to.stat(item.key)
    if (existing?.size === source.size && (existing.sha256 ?? (await digest(to, item.key))?.sha256) === source.sha256) {
      skipped += 1
      continue
    }
    const got = await from.get(item.key)
    if (!got) continue
    await to.put(item.key, got.body, { sha256: source.sha256, contentType: guessMime(basename(item.key)) })
    const written = await digest(to, item.key)
    if (written?.sha256 !== source.sha256 || written.size !== source.size) throw new Error(`Verification failed for ${item.key}: the copy does not match the source`)
    copied += 1
    log(`[storage] copied ${item.key} (${String(source.size)} bytes)`)
  }
  return { copied, skipped }
}

/** Whether something already listens on the server's port: copying under a running server could miss new uploads. */
function serverListening(config: ServerConfig): Promise<boolean> {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  return new Promise((resolve) => {
    const socket = connect({ host, port: config.port })
    const done = (up: boolean): void => { socket.destroy(); resolve(up) }
    socket.setTimeout(1000, () => { done(false) })
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
  })
}

export async function runStorage(ctx: StorageCliContext, args: string[]): Promise<number> {
  const [command, ...rest] = args
  const flag = (name: string): string | undefined => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : undefined }
  const source = flag('--from')
  const target = flag('--to')
  if (command !== 'copy-blobs' || !source || !target || !KINDS.has(source) || !KINDS.has(target) || source === target) {
    ctx.warn(USAGE)
    return 2
  }
  loadStartupEnv({ env: ctx.env, webRoot: ctx.webRoot, home: ctx.home, log: ctx.warn })
  const config = loadConfig({ env: ctx.env, webRoot: ctx.webRoot, home: ctx.home, warn: ctx.warn })
  if (await serverListening(config)) {
    ctx.warn(`[storage] Talaria Web is listening on port ${String(config.port)}; stop the server before copying attachments.`)
    return 1
  }
  // The copy's S3 cache is its own scratch directory, never the server's.
  const scratch = mkdtempSync(join(tmpdir(), 'talaria-copy-blobs-'))
  const open = (kind: string): Promise<BlobStore> => {
    const blobs = kind === 'local' ? { kind: 'local' as const } : { ...loadBlobConfig({ ...ctx.env, TALARIA_BLOB_STORAGE: 's3' }, config.stateDir, ctx.warn), cacheDir: scratch }
    return createBlobStore({ ...config, blobs }, () => localAttachmentRoot(ctx.env, config.stateDir, ctx.home))
  }
  const stores: BlobStore[] = []
  try {
    const from = await open(source)
    stores.push(from)
    const to = await open(target)
    stores.push(to)
    const { copied, skipped } = await copyBlobs(from, to, ctx.log)
    ctx.log(`[storage] copy-blobs ${source} -> ${target}: ${String(copied)} copied, ${String(skipped)} already present`)
    return 0
  } catch (error) {
    ctx.warn(`[storage] copy-blobs failed: ${(error as Error).message}`)
    return 1
  } finally {
    for (const store of stores) await store.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}
