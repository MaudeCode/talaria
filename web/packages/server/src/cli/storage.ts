/**
 * `talaria-web storage`, run while the server is stopped; a re-run copies only what is missing or different, and the
 * source is never modified:
 * - `copy --from <json|sqlite> --to <json|sqlite>` (TAL-1066) moves every session, backup, tombstone, document and run
 *   journal between storage backends, then verifies the copy.
 * - `copy-blobs --from <local|s3> --to <local|s3>` (TAL-1069) copies every chat attachment between blob stores,
 *   verifying each object by size and SHA-256.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { assertStorageKind, loadBlobConfig, loadConfig } from '../config.js'
import { createStorage } from '../runtime.js'
import { copyStorage, verifyStorage } from '../sessions/storage/copy.js'
import { ATTACHMENTS, createBlobStore, localAttachmentRoot, type BlobStore } from '../sessions/storage/blobs.js'
import { guessMime } from '../workspace/upload.js'
import { ctlPaths, runningServer } from './ctl.js'
import { loadStartupEnv } from './dotenv.js'

export interface StorageCliContext { env: Record<string, string | undefined>; webRoot: string; home: string; log: (line: string) => void; warn: (line: string) => void }

const COPY_USAGE = 'Usage: talaria-web storage copy --from <json|sqlite> --to <json|sqlite>'
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

/** Why the server counts as running (`talaria-web ctl status`'s checks); copying under it could miss new writes. */
async function serverRunning(ctx: StorageCliContext): Promise<string | null> {
  return runningServer({ ...ctx, serveCommand: [] }, ctlPaths({ ...ctx, serveCommand: [] }))
}

/** `copy`: move sessions, documents and journals between storage backends, then verify every item. */
async function copyStore(ctx: StorageCliContext, from: string, to: string): Promise<number> {
  try { assertStorageKind(from); assertStorageKind(to) } catch (error) { ctx.warn(`[storage] ${(error as Error).message}`); return 2 }
  if (from === to) { ctx.warn(COPY_USAGE); return 2 }
  loadStartupEnv({ env: ctx.env, webRoot: ctx.webRoot, home: ctx.home, log: ctx.warn })
  const running = await serverRunning(ctx)
  if (running) { ctx.warn(`[storage] ${running}. Stop it first ('talaria-web ctl stop'); copying a store in use could miss its latest writes.`); return 1 }
  const config = loadConfig({ env: ctx.env, webRoot: ctx.webRoot, home: ctx.home, warn: ctx.warn })
  const source = createStorage({ ...config, storage: from })
  try {
    const destination = createStorage({ ...config, storage: to })
    try {
      ctx.log(`[storage] Copying ${from} storage to ${to}`)
      const report = await copyStorage(source, destination)
      ctx.log(`[storage] Copied or removed ${String(report.copied)} items; ${String(report.unchanged)} already matched`)
      const mismatches = [...new Set([...report.failures, ...await verifyStorage(source, destination)])]
      if (mismatches.length) {
        for (const line of mismatches) ctx.warn(`[storage] Mismatch: ${line}`)
        ctx.warn(`[storage] Verification failed for ${String(mismatches.length)} items; keep TALARIA_STORAGE=${from}. The ${from} store is unchanged.`)
        return 1
      }
      ctx.log('[storage] Verified every item. To use the copy, set:')
      ctx.log(`TALARIA_STORAGE=${to}`)
      return 0
    } finally { await destination.close() }
  } finally { await source.close() }
}

export async function runStorage(ctx: StorageCliContext, args: string[]): Promise<number> {
  const [command, ...rest] = args
  const flag = (name: string): string | undefined => {
    const at = rest.indexOf(name)
    return at >= 0 ? rest[at + 1] : rest.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
  }
  const source = flag('--from')
  const target = flag('--to')
  if (command === 'copy' && source && target) return copyStore(ctx, source, target)
  if (command !== 'copy-blobs' || !source || !target || !KINDS.has(source) || !KINDS.has(target) || source === target) {
    if (command !== 'copy-blobs') ctx.warn(COPY_USAGE)
    ctx.warn(USAGE)
    return 2
  }
  loadStartupEnv({ env: ctx.env, webRoot: ctx.webRoot, home: ctx.home, log: ctx.warn })
  const config = loadConfig({ env: ctx.env, webRoot: ctx.webRoot, home: ctx.home, warn: ctx.warn })
  const running = await serverRunning(ctx)
  if (running) {
    ctx.warn(`[storage] ${running}; stop the server before copying attachments.`)
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
