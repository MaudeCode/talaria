/**
 * Byte-exact gzip archives of settled run journals (TAL-1380). A run's logical journal is its archived prefix followed by
 * the live rows past it; every reader, the writer's sequence resume, and re-archival read it through `runLines`, so they
 * share one resolution and sequence rule.
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, renameSync, unlinkSync, constants as fsConstants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { writeFullyAsync } from '../../fs/atomic.js'
import type { JournalEvent } from '../journal.js'

export const ARCHIVE_DIR = '_archive'
export const ARCHIVE_SUFFIX = '.jsonl.gz'
/** Archival pins what it reads and publishes without following symlinks; a platform without it keeps journals live. */
export const NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW
const PAGE_BYTES = 64 * 1024
const NL = Buffer.from('\n')

/** An archive that exists but cannot be trusted: unreadable, corrupt, foreign-owned, or contradicted by live rows. */
export class JournalArchiveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'JournalArchiveError' }
}

/** One line of a logical journal: its bytes without the newline, and the parsed row when it is one. */
export interface JournalLine { bytes: Buffer; terminated: boolean; event: JournalEvent | null }

function parseRow(bytes: Buffer): JournalEvent | null {
  if (!bytes.length) return null
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JournalEvent : null
  } catch { return null }
}

/**
 * A file's bytes from `start`, a fresh buffer per page. A read failure throws rather than ending the file early, so
 * archival never verifies and publishes a prefix as the whole journal.
 */
export async function* fileChunks(handle: FileHandle, start = 0): AsyncGenerator<Buffer> {
  for (let position = start; ;) {
    const page = Buffer.allocUnsafe(PAGE_BYTES)
    const n = (await handle.read(page, 0, page.length, position)).bytesRead
    if (n <= 0) return
    position += n
    yield page.subarray(0, n)
  }
}

/** Decompressed archive bytes, streamed; any read or gzip failure is untrusted authority. */
export function gunzipped(handle: FileHandle): AsyncGenerator<Buffer> { return gunzipChunks(fileChunks(handle)) }

/** Decompressed bytes of a gzip source (a file, or an archive blob a database holds), streamed one output chunk at a time. */
export async function* gunzipChunks(source: Iterable<Buffer> | AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const gunzip = createGunzip()
  const feeding = pipeline(Readable.from(source), gunzip).catch(() => undefined)
  try {
    for await (const chunk of gunzip) yield chunk as Buffer
  } catch (error) {
    throw new JournalArchiveError('The run-journal archive is unreadable', { cause: error })
  } finally {
    gunzip.destroy()
    await feeding
  }
}

/** A request's remaining read budget, shared by every source it reads. */
export interface ReadBudget { remaining: number }
/** The read passed its budget; raised per chunk, before a row is assembled or parsed. */
export class JournalReadLimit extends Error {
  constructor() { super('The run-journal read passed its byte budget'); this.name = 'JournalReadLimit' }
}

/** Lines split at the 0x0A byte, which never occurs inside a UTF-8 sequence; only the last line can be unterminated. */
export async function* splitLines(chunks: AsyncIterable<Buffer>, budget?: ReadBudget): AsyncGenerator<JournalLine> {
  let parts: Buffer[] = []
  for await (const chunk of chunks) {
    if (budget && (budget.remaining -= chunk.length) < 0) throw new JournalReadLimit()
    let start = 0
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
      parts.push(chunk.subarray(start, nl))
      const bytes = parts.length === 1 ? parts[0]! : Buffer.concat(parts)
      parts = []
      start = nl + 1
      yield { bytes, terminated: true, event: parseRow(bytes) }
    }
    if (start < chunk.length) parts.push(chunk.subarray(start))
  }
  if (parts.length) { const bytes = Buffer.concat(parts); yield { bytes, terminated: false, event: parseRow(bytes) } }
}

/**
 * A run's logical journal. Live rows the archive already holds (a crash between publishing an archive and removing the
 * live file) must repeat the archive's bytes at the same seq and are read once, as are the archive's own trailing torn
 * or malformed lines repeated after them; every other live line follows the archive. Any other overlap, and archive rows
 * of another session or run, refuse instead of masking either copy. `budget` bounds the bytes read from both sources.
 */
export async function* runLines(archive: FileHandle | null, live: FileHandle | null, sessionId: string, runId: string, budget?: ReadBudget): AsyncGenerator<JournalLine> {
  const liveLines = live ? splitLines(fileChunks(live), budget) : null
  if (!archive) { if (liveLines) yield* liveLines; return }
  // The next live row, and the non-row lines before it.
  const pending: { next: JournalLine | null; held: JournalLine[] } = { next: null, held: [] }
  const advance = async (): Promise<void> => {
    pending.held = []
    pending.next = null
    for (;;) {
      const line = await liveLines?.next()
      if (!line || line.done) return
      if (line.value.event) { pending.next = line.value; return }
      pending.held.push(line.value)
    }
  }
  const contradiction = (): JournalArchiveError => new JournalArchiveError('Live journal rows contradict the archive')
  try {
    await advance()
    let archived = 0
    let matched = false
    // The archive's lines after its last row, which a crash-left live copy repeats.
    let trailing: Buffer[] = []
    for await (const line of splitLines(gunzipped(archive), budget)) {
      if (line.event) {
        if (line.event.session_id !== sessionId || line.event.run_id !== runId) throw new JournalArchiveError('The run-journal archive belongs to another run')
        archived = line.event.seq
        trailing = []
        if (pending.next?.event?.seq === archived) {
          if (!pending.next.bytes.equals(line.bytes)) throw contradiction()
          matched = true
          await advance()
        }
      } else trailing.push(line.bytes)
      yield line
    }
    const first = pending.next
    if (!first?.event) {
      const repeated = matched && pending.held.length === trailing.length && pending.held.every((line, i) => line.bytes.equals(trailing[i]!))
      if (!repeated) yield* pending.held
      return
    }
    if (!(first.event.seq > archived)) throw contradiction()
    yield* pending.held
    yield first
    for (;;) {
      const line = await liveLines?.next()
      if (!line || line.done) return
      if (line.value.event && !(line.value.event.seq > archived)) throw contradiction()
      yield line.value
    }
  } finally {
    await liveLines?.return(undefined)
  }
}

/** The logical journal's bytes: every line but an unterminated last one ends in a newline, so joined runs never merge rows. */
export async function* logicalBytes(lines: AsyncIterable<JournalLine>): AsyncGenerator<Buffer> {
  let previous: JournalLine | null = null
  for await (const line of lines) {
    if (previous) yield Buffer.concat([previous.bytes, NL])
    previous = line
  }
  if (previous) yield previous.terminated ? Buffer.concat([previous.bytes, NL]) : previous.bytes
}

async function* hashed(chunks: AsyncIterable<Buffer>, hash: ReturnType<typeof createHash>): AsyncGenerator<Buffer> {
  for await (const chunk of chunks) { hash.update(chunk); yield chunk }
}

export async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

let staged = 0
/**
 * A temp beside its target, created synchronously so a session deletion running between async steps can remove it but
 * never races its creation. `publish` renames it synchronously once its `commit` check passes; the caller fsyncs the
 * directory before relying on the rename.
 */
export class StagedFile {
  private constructor(readonly tmp: string, private readonly target: string, private handle: FileHandle | null) {}

  static async create(dir: string, name: string, write: (handle: FileHandle) => Promise<void>): Promise<StagedFile | null> {
    const tmp = join(dir, `.${name}.${String(process.pid)}.${String(++staged)}.tmp`)
    const flags = NOFOLLOW ?? 0
    try { closeSync(openSync(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | flags, 0o600)) } catch { return null }
    const file = new StagedFile(tmp, join(dir, name), null)
    try {
      file.handle = await open(tmp, fsConstants.O_WRONLY | flags)
      await write(file.handle)
      return file
    } catch { await file.discard(); return null }
  }

  async sync(): Promise<void> {
    const handle = this.handle
    this.handle = null
    if (!handle) throw new Error('staged file is closed')
    try { await handle.sync() } finally { await handle.close() }
  }

  publish(commit: () => boolean): boolean {
    if (this.handle || !commit()) return false
    try { renameSync(this.tmp, this.target); return true } catch { return false }
  }

  async discard(): Promise<void> {
    await this.handle?.close().catch(() => undefined)
    this.handle = null
    try { unlinkSync(this.tmp) } catch { /* published or already gone */ }
  }
}

/** Gzip `content` into a staged archive; `verify` then proves its decompression repeats the content byte for byte. */
export async function stageArchive(dir: string, name: string, content: AsyncIterable<Buffer>, signal?: AbortSignal): Promise<{ file: StagedFile; verify: () => Promise<boolean> } | null> {
  const expected = createHash('sha256')
  const file = await StagedFile.create(dir, name, async (handle) => {
    const sink = async (source: AsyncIterable<Buffer>): Promise<void> => { for await (const chunk of source) await writeFullyAsync(handle, chunk) }
    await pipeline(Readable.from(hashed(content, expected)), createGzip(), sink, { signal: signal ?? new AbortController().signal })
  })
  if (!file) return null
  const digest = expected.digest()
  const verify = async (): Promise<boolean> => {
    const actual = createHash('sha256')
    try {
      const check = await open(file.tmp, fsConstants.O_RDONLY | (NOFOLLOW ?? 0))
      try { for await (const chunk of gunzipped(check)) actual.update(chunk) } finally { await check.close() }
    } catch { return false }
    return actual.digest().equals(digest)
  }
  return { file, verify }
}
