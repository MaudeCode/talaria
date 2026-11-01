import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import * as fsp from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { retentionPolicy, type JournalEvent, type RunSummary } from '../journal.js'
import { sessionRunReferences } from '../../tools/hygiene.js'
import { JournalArchiveError, JsonJournal, JsonJournalWriter } from './json-journal.js'
import { StagedFile } from './json-journal-archive.js'

vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, renameSync: vi.fn(real.renameSync), openSync: vi.fn(real.openSync) }
})
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, open: vi.fn(real.open) }
})
vi.mock('node:zlib', async (original) => {
  const real = await original<typeof zlib>()
  return { ...real, createGzip: vi.fn(real.createGzip), createGunzip: vi.fn(real.createGunzip) }
})

const DAY = 86400
const dirs: string[] = []
const journals: JsonJournal[] = []
const fixture = (dir = fs.mkdtempSync(join(tmpdir(), 'talaria-archive-'))): JsonJournal => {
  if (!dirs.includes(dir)) dirs.push(dir)
  const journal = new JsonJournal(dir)
  journals.push(journal)
  return journal
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(fs.renameSync).mockReset().mockImplementation((await vi.importActual<typeof fs>('node:fs')).renameSync)
  vi.mocked(fsp.open).mockReset().mockImplementation((await vi.importActual<typeof fsp>('node:fs/promises')).open)
  vi.mocked(zlib.createGzip).mockReset().mockImplementation((await vi.importActual<typeof zlib>('node:zlib')).createGzip)
  for (const journal of journals.splice(0)) await journal.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Large Unicode text with the raw separators a line splitter other than `\n` would break on. */
const UNICODE = `🌲 é 中文 \u0085     `.repeat(12_000)
const old = Date.now() / 1000 - 30 * DAY

async function writeRun(journal: JsonJournal, sid: string, rid: string, opts: { mtime?: number; terminal?: boolean; text?: string } = {}): Promise<void> {
  const writer = await journal.writer(sid, rid)
  await writer.appendSseEvent('token', { text: opts.text ?? 'hi' })
  await writer.appendSseEvent('tool', { name: 'read', tid: 't1' })
  if (opts.terminal ?? true) await writer.appendSseEvent('done', { session_id: sid })
  await writer.close()
  fs.utimesSync(journal.pathFor(sid, rid), opts.mtime ?? old, opts.mtime ?? old)
}

/** Everything a reader observes about a run and its session. */
async function observe(journal: JsonJournal, sid: string, rid: string) {
  const summary: Partial<RunSummary> = { ...(await journal.findRunSummary(rid)) }
  delete summary.path
  const replay = await journal.readSessionRunEvents(sid, `${rid}:1`)
  return {
    rows: await journal.readRunEvents(sid, rid),
    after: await journal.readRunEvents(sid, rid, { afterSeq: 1, maxSeq: 2 }),
    tail: await journal.readRunEventTail(sid, rid, 1024, 2),
    summary,
    latest: await journal.latestRunSummary(sid, rid),
    replay: { status: replay.status, events: replay.events },
    missing: (await journal.readSessionRunEvents(sid, `${rid}:99`)).status,
    streams: await journal.streams(sid),
  }
}

const sweep = (journal: JsonJournal, opts: Parameters<JsonJournal['pruneSettled']>[0] = {}) => journal.pruneSettled({ now: Date.now() / 1000, retentionSeconds: 14 * DAY, keepRecent: 0, maxRuns: 0, maxBytes: 0, ...opts })
const tempFiles = (journal: JsonJournal, sid: string): string[] => [join(journal.root(), sid), join(journal.root(), sid, '_archive')].flatMap((dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')) } catch { return [] } })

describe('run-journal archival', () => {
  it.each([
    ['age', {}],
    ['count', { retentionSeconds: 365 * DAY, maxRuns: 1 }],
    ['bytes', { retentionSeconds: 365 * DAY, maxBytes: 8192 }],
  ] as const)('a run archived by %s replays identically, before and after a cold restart', async (_reason, opts) => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run', { text: UNICODE })
    await writeRun(journal, 'session', 'next', { mtime: Date.now() / 1000, text: 'x'.repeat(2048) })
    const original = fs.readFileSync(journal.pathFor('session', 'run'))
    const before = await observe(journal, 'session', 'run')
    expect(before.rows.map((e) => e.event_id)).toEqual(['run:1', 'run:2', 'run:3'])
    expect(before.replay.status).toBe('ok')
    expect(await sweep(journal, opts)).toMatchObject({ pruned: 1, bytes_reclaimed: original.length })
    expect(fs.existsSync(journal.pathFor('session', 'run'))).toBe(false)
    expect(fs.existsSync(journal.pathFor('session', 'next')), 'only the due run is archived').toBe(true)
    expect(zlib.gunzipSync(fs.readFileSync(journal.archivePathFor('session', 'run'))).equals(original), 'the archive repeats the journal byte for byte').toBe(true)
    expect(await observe(journal, 'session', 'run')).toEqual(before)
    expect((await journal.readRunEvents('session', 'run'))[0]?.payload).toEqual({ text: UNICODE })
    expect(await observe(fixture(journal.sessionDir), 'session', 'run'), 'a restarted server reads the same run').toEqual(before)
    expect(tempFiles(journal, 'session')).toEqual([])
  })

  it('keeps torn trailing bytes and the replay status they produce', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    fs.appendFileSync(journal.pathFor('session', 'run'), '{"seq":4,"event":"tok')
    fs.utimesSync(journal.pathFor('session', 'run'), old, old)
    const original = fs.readFileSync(journal.pathFor('session', 'run'))
    const before = await observe(journal, 'session', 'run')
    expect(before.replay.status).toBe('replay_malformed')
    expect((await sweep(journal)).pruned).toBe(1)
    expect(zlib.gunzipSync(fs.readFileSync(journal.archivePathFor('session', 'run'))).equals(original)).toBe(true)
    expect(await observe(journal, 'session', 'run')).toEqual(before)
    // A writer continues past the archived prefix; the torn line never merges with the new row.
    const writer = await journal.writer('session', 'run')
    expect(await writer.appendSseEvent('token', { text: 'after' })).toMatchObject({ seq: 4, event_id: 'run:4' })
    await writer.close()
    expect((await journal.readRunEvents('session', 'run')).map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('reads a crash-left live copy once, re-archives it idempotently, and continues the sequence', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    const original = fs.readFileSync(journal.pathFor('session', 'run'))
    const before = await journal.readRunEvents('session', 'run')
    await sweep(journal)
    // A crash between publishing the archive and removing the live journal leaves both.
    fs.writeFileSync(journal.pathFor('session', 'run'), original)
    fs.utimesSync(journal.pathFor('session', 'run'), old, old)
    expect(await journal.readRunEvents('session', 'run')).toEqual(before)
    expect((await journal.readSessionRunEvents('session', 'run:1')).events.map((e) => e.seq)).toEqual([2, 3])
    expect((await sweep(journal)).pruned).toBe(1)
    expect(await sweep(journal), 'a repeated sweep has nothing left to archive').toMatchObject({ pruned: 0 })
    expect(zlib.gunzipSync(fs.readFileSync(journal.archivePathFor('session', 'run'))).equals(original)).toBe(true)
    // Hot and cold writers continue past the archive, and the next archival merges the continuation.
    const hot = await journal.writer('session', 'run')
    expect(await hot.appendSseEvent('token', { text: 'hot' })).toMatchObject({ seq: 4 })
    await hot.close()
    const cold = await fixture(journal.sessionDir).writer('session', 'run')
    expect(await cold.appendSseEvent('done', { session_id: 'session' })).toMatchObject({ seq: 5 })
    await cold.close()
    const continued = await journal.readRunEvents('session', 'run')
    expect(continued.map((e) => e.event_id)).toEqual(['run:1', 'run:2', 'run:3', 'run:4', 'run:5'])
    fs.utimesSync(journal.pathFor('session', 'run'), old, old)
    expect((await sweep(journal)).pruned).toBe(1)
    expect(await journal.readRunEvents('session', 'run')).toEqual(continued)
    expect((await journal.readSessionRunEvents('session', 'run:3')).events.map((e) => e.seq)).toEqual([4, 5])
  })

  it.each(['corrupt', 'truncated', 'foreign', 'contradicted', 'symlinked'] as const)('refuses replay and append over a %s archive', async (damage) => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    await sweep(journal)
    const archive = journal.archivePathFor('session', 'run')
    const bytes = fs.readFileSync(archive)
    if (damage === 'corrupt') fs.writeFileSync(archive, 'not gzip')
    if (damage === 'truncated') fs.writeFileSync(archive, bytes.subarray(0, bytes.length - 8))
    if (damage === 'foreign') fs.writeFileSync(archive, zlib.gzipSync(zlib.gunzipSync(bytes).toString('utf8').replaceAll('"session_id":"session"', '"session_id":"other"')))
    if (damage === 'contradicted') {
      // A live journal restarting at seq 1 with other content, as a writer that never saw the archive would leave.
      const writer = new JsonJournalWriter(journal, 'session', 'run', 'terminal-only')
      await writer.appendSseEvent('token', { text: 'a different first row' })
      await writer.close()
    }
    if (damage === 'symlinked') { fs.renameSync(archive, `${archive}.real`); fs.symlinkSync(`${archive}.real`, archive) }
    await expect(journal.readRunEvents('session', 'run')).rejects.toBeInstanceOf(JournalArchiveError)
    await expect(journal.writer('session', 'run'), 'no new sequence starts over untrusted history').rejects.toBeInstanceOf(JournalArchiveError)
    expect((await journal.readSessionRunEvents('session', 'run:1')).status).toBe('replay_unreadable')
    if (damage === 'contradicted') {
      fs.utimesSync(journal.pathFor('session', 'run'), old, old)
      expect((await sweep(journal)).pruned, 'archival never merges contradicting copies').toBe(0)
      expect(fs.existsSync(journal.pathFor('session', 'run'))).toBe(true)
    }
  })

  it.each(['compression', 'write', 'verification', 'fsync', 'publication'] as const)('a %s failure leaves the live journal readable', async (step) => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    const before = await journal.readRunEvents('session', 'run')
    const real = await vi.importActual<typeof zlib>('node:zlib')
    if (step === 'compression') vi.mocked(zlib.createGzip).mockImplementationOnce(() => { const gzip = real.createGzip(); setImmediate(() => gzip.destroy(new Error('ENOMEM'))); return gzip })
    // The staged bytes no longer decompress to the journal, as after a bad write or media corruption.
    if (step === 'verification') vi.spyOn(StagedFile.prototype, 'sync').mockImplementationOnce(async function (this: StagedFile) { await this.sync(); fs.writeFileSync(this.tmp, real.gzipSync('different bytes')) })
    if (step === 'write') vi.spyOn(StagedFile, 'create').mockResolvedValueOnce(null)
    if (step === 'fsync') vi.spyOn(StagedFile.prototype, 'sync').mockRejectedValueOnce(new Error('EIO'))
    if (step === 'publication') vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('EXDEV') })
    expect(await sweep(journal)).toMatchObject({ pruned: 0 })
    expect(fs.existsSync(journal.pathFor('session', 'run'))).toBe(true)
    expect(fs.existsSync(journal.archivePathFor('session', 'run'))).toBe(false)
    expect(fs.existsSync(journal.pathFor('session', 'run').replace(/\.jsonl$/, '.summary.json'))).toBe(false)
    expect(tempFiles(journal, 'session')).toEqual([])
    expect(await journal.readRunEvents('session', 'run')).toEqual(before)
    expect((await sweep(journal)).pruned, 'the next sweep archives it').toBe(1)
    expect(await journal.readRunEvents('session', 'run')).toEqual(before)
  })

  it('never archives a prefix when reading the live journal fails part way', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run', { text: 'x'.repeat(100_000) })
    const path = journal.pathFor('session', 'run')
    const before = await journal.readRunEvents('session', 'run')
    const real = await vi.importActual<typeof fsp>('node:fs/promises')
    // Every read of the live journal past its first page fails, as on a disk error.
    vi.mocked(fsp.open).mockImplementation(async (file, ...rest) => {
      const handle = await real.open(file, ...rest)
      if (file !== path) return handle
      const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<{ bytesRead: number }>
      Object.assign(handle, { read: (...args: unknown[]) => (Number(args[3]) >= 65536 ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) : read(...args)) })
      return handle
    })
    expect(await sweep(journal)).toMatchObject({ pruned: 0 })
    vi.mocked(fsp.open).mockImplementation(real.open)
    expect(fs.existsSync(path), 'the live journal stays').toBe(true)
    expect(fs.existsSync(journal.archivePathFor('session', 'run'))).toBe(false)
    expect(await journal.readRunEvents('session', 'run')).toEqual(before)
  })

  it('refuses a run whose live continuation cannot be opened instead of reading only its archive', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    await sweep(journal)
    const writer = await journal.writer('session', 'run')
    await writer.appendSseEvent('token', { text: 'continuation' })
    await writer.close()
    const real = await vi.importActual<typeof fsp>('node:fs/promises')
    const path = journal.pathFor('session', 'run')
    vi.mocked(fsp.open).mockImplementation(async (file, ...rest) => (file === path ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) : real.open(file, ...rest)))
    await expect(journal.writer('session', 'run'), 'a writer never resumes behind persisted rows').rejects.toMatchObject({ code: 'EIO' })
    await expect(journal.readRunEvents('session', 'run')).rejects.toMatchObject({ code: 'EIO' })
    vi.mocked(fsp.open).mockImplementation(real.open)
    expect((await journal.readRunEvents('session', 'run')).map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('keeps a torn live continuation past the archive, and never archives without it', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    await sweep(journal)
    // A crash during the first append after archival leaves only a torn row in the live journal.
    fs.writeFileSync(journal.pathFor('session', 'run'), '{"seq":4,"event":"to')
    fs.utimesSync(journal.pathFor('session', 'run'), old, old)
    expect((await journal.readSessionRunEvents('session', 'run:1')).status).toBe('replay_malformed')
    expect((await sweep(journal)).pruned).toBe(1)
    expect(zlib.gunzipSync(fs.readFileSync(journal.archivePathFor('session', 'run'))).toString('utf8').endsWith('\n{"seq":4,"event":"to'), 'the torn bytes survive re-archival').toBe(true)
    expect((await journal.readSessionRunEvents('session', 'run:1')).status).toBe('replay_malformed')
  })

  it('stops a session replay at its byte budget before assembling an archived row', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run', { text: 'x'.repeat(6 * 1024 * 1024) })
    await sweep(journal)
    const concat = vi.spyOn(Buffer, 'concat')
    expect((await journal.readSessionRunEvents('session', 'run:1')).status).toBe('replay_limit_bytes')
    const largest = Math.max(0, ...concat.mock.results.map((r) => (r.value as Buffer).length))
    expect(largest, 'no buffer past the 4 MiB replay budget').toBeLessThanOrEqual(4 * 1024 * 1024)
  })

  it('never reads a run as empty while retention archives it', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    const before = await journal.readRunEvents('session', 'run')
    const real = await vi.importActual<typeof fsp>('node:fs/promises')
    // The sweep finishes while the reader is opening the run, before its live journal open lands.
    let race = true
    vi.mocked(fsp.open).mockImplementation(async (file, ...rest) => {
      if (race && file === journal.pathFor('session', 'run')) {
        race = false
        expect((await sweep(journal)).pruned).toBe(1)
      }
      return real.open(file, ...rest)
    })
    expect(await journal.readRunEvents('session', 'run')).toEqual(before)
    expect(race, 'the race ran').toBe(false)
  })

  /** Run `race` while the sweep is between its first check and publication (the archive's fsync). */
  const duringPublication = (race: () => void | Promise<void>): void => {
    // Once this implementation is used up, the spy calls through to the real fsync.
    vi.spyOn(StagedFile.prototype, 'sync').mockImplementationOnce(async function (this: StagedFile) { await race(); await this.sync() })
  }

  it.each(['replacement', 'symlink', 'archive directory swap', 'append', 'reopen'] as const)('never publishes over a %s during archival', async (change) => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    const path = journal.pathFor('session', 'run')
    const before = await journal.readRunEvents('session', 'run')
    let writer: Awaited<ReturnType<JsonJournal['writer']>> | null = null
    duringPublication(async () => {
      if (change === 'replacement') { fs.writeFileSync(`${path}.new`, fs.readFileSync(path)); fs.renameSync(`${path}.new`, path) }
      if (change === 'symlink') { fs.renameSync(path, `${path}.moved`); fs.symlinkSync(`${path}.moved`, path) }
      if (change === 'archive directory swap') { const dir = join(journal.root(), 'session', '_archive'); fs.renameSync(dir, `${dir}.moved`); fs.mkdirSync(dir) }
      if (change === 'append') fs.appendFileSync(path, '\n')
      if (change === 'reopen') writer = await journal.writer('session', 'run')
    })
    expect(await sweep(journal)).toMatchObject({ pruned: 0 })
    expect(fs.existsSync(journal.archivePathFor('session', 'run'))).toBe(false)
    expect(fs.existsSync(path)).toBe(true)
    expect(await journal.readRunEvents('session', 'run')).toEqual(before)
    await (writer as { close(): Promise<void> } | null)?.close()
  })

  it('keeps the live journal when a writer reopens it after the archive is published', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    let calls = 0
    let writer: Awaited<ReturnType<JsonJournal['writer']>> | null = null
    // The second lookup runs after publication, right before the live bytes would go.
    const protectedRuns = async (): Promise<Set<string>> => { if (++calls === 2) writer = await journal.writer('session', 'run'); return new Set() }
    expect(await sweep(journal, { protectedRuns })).toMatchObject({ pruned: 0 })
    expect(fs.existsSync(journal.archivePathFor('session', 'run'))).toBe(true)
    expect(fs.existsSync(journal.pathFor('session', 'run'))).toBe(true)
    const next = await (writer as unknown as { appendSseEvent(e: string, p: unknown): Promise<JournalEvent> }).appendSseEvent('token', { text: 'after publication' })
    expect(next).toMatchObject({ seq: 4 })
    expect((await journal.readRunEvents('session', 'run')).map((e) => e.seq)).toEqual([1, 2, 3, 4])
    await (writer as unknown as { close(): Promise<void> }).close()
  })

  it('never recreates a session deleted while its run is archived, and deletes archives with the session', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    duringPublication(async () => { expect(await journal.deleteSession('session')).toBe(true) })
    expect(await sweep(journal)).toMatchObject({ pruned: 0 })
    expect(fs.existsSync(join(journal.root(), 'session')), 'the deleted session stays deleted').toBe(false)
    await writeRun(journal, 'kept', 'run')
    await sweep(journal)
    expect(fs.existsSync(journal.archivePathFor('kept', 'run'))).toBe(true)
    // Within the archive budget nothing expires: archives outlive any number of later sweeps.
    expect(await sweep(journal, { now: Date.now() / 1000 + 3650 * DAY })).toMatchObject({ pruned: 0 })
    expect((await journal.readRunEvents('kept', 'run')).length).toBe(3)
    expect(await journal.deleteSession('kept')).toBe(true)
    expect(fs.existsSync(join(journal.root(), 'kept'))).toBe(false)
    expect(await journal.readRunEvents('kept', 'run')).toEqual([])
    expect(await journal.findRunSummary('run')).toBeNull()
  })

  it('answers lookups of an archived run from its bounded summary, without inflating the archive', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run', { text: UNICODE })
    const before = await journal.findRunSummary('run')
    await sweep(journal)
    vi.mocked(zlib.createGunzip).mockClear()
    const fresh = fixture(journal.sessionDir)
    expect(await fresh.findRunSummary('run')).toEqual({ ...before, path: journal.archivePathFor('session', 'run') })
    expect(await fresh.latestRunSummary('session', 'run')).toEqual(await journal.latestRunSummary('session', 'run'))
    expect(await fresh.summary('session', 'run')).toMatchObject({ terminal: true, last_seq: 3 })
    expect(zlib.createGunzip, 'status lookups never decompress an archive').not.toHaveBeenCalled()
  })

  it('leaves the previous Stable a summary of every archived run', async () => {
    const journal = fixture()
    await writeRun(journal, 'session', 'run')
    const size = fs.statSync(journal.pathFor('session', 'run')).size
    const now = Date.now() / 1000
    await sweep(journal, { now })
    const legacy = JSON.parse(fs.readFileSync(join(journal.root(), 'session', 'run.summary.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(legacy)).toEqual(['session_id', 'run_id', 'stream_id', 'event_count', 'last_seq', 'last_event_id', 'terminal', 'terminal_state', 'last_event', 'journal_pruned', 'journal_pruned_at', 'original_size', 'original_mtime', 'archived'])
    expect(legacy).toMatchObject({ session_id: 'session', run_id: 'run', last_seq: 3, terminal: true, journal_pruned: true, journal_pruned_at: now, original_size: size })
    // This release reads the archive, not the summary.
    expect((await journal.findRunSummary('run'))?.journal_pruned).toBeUndefined()
  })
})

describe('retention budgets and protection', () => {
  const runs = async (journal: JsonJournal, sid: string, count: number, opts: { mtime?: number } = {}): Promise<void> => {
    for (let i = 0; i < count; i += 1) await writeRun(journal, sid, `run${String(i)}`, { mtime: (opts.mtime ?? old) + i })
  }
  const live = (journal: JsonJournal, sid: string, count: number): boolean[] => [...Array(count).keys()].map((i) => fs.existsSync(journal.pathFor(sid, `run${String(i)}`)))

  it('archives the oldest runs past a soft budget, above the keep-recent floor', async () => {
    const journal = fixture()
    const fresh = Date.now() / 1000 - 60
    await runs(journal, 'count', 6, { mtime: fresh })
    await writeRun(journal, 'count', 'open', { terminal: false, mtime: fresh - 10 })
    expect(await sweep(journal, { retentionSeconds: 14 * DAY, maxRuns: 4, keepRecent: 1 })).toMatchObject({ pruned: 3 })
    expect(live(journal, 'count', 6), 'the oldest settled runs go first').toEqual([false, false, false, true, true, true])
    expect(fs.existsSync(journal.pathFor('count', 'open')), 'a nonterminal run is never archived').toBe(true)
    // The keep-recent floor wins over the budget, which stays soft.
    const floor = fixture()
    await runs(floor, 'floor', 5, { mtime: fresh })
    expect(await sweep(floor, { retentionSeconds: 14 * DAY, maxRuns: 1, keepRecent: 3 })).toMatchObject({ pruned: 2 })
    expect(live(floor, 'floor', 5)).toEqual([false, false, true, true, true])
    // Bytes: archive until the session's live bytes fit.
    const bytes = fixture()
    await runs(bytes, 'bytes', 4, { mtime: fresh })
    const each = fs.statSync(bytes.pathFor('bytes', 'run0')).size
    expect(await sweep(bytes, { retentionSeconds: 14 * DAY, maxBytes: each * 2 + 64 })).toMatchObject({ pruned: 2 })
    expect(live(bytes, 'bytes', 4)).toEqual([false, false, true, true])
  })

  it('keeps runs the session still names, and whole sessions whose state is unreadable', async () => {
    const journal = fixture()
    await runs(journal, 'named', 3)
    await runs(journal, 'unreadable', 2)
    await runs(journal, 'throws', 2)
    const protectedRuns = (sid: string): Promise<Set<string> | null> => {
      if (sid === 'throws') return Promise.reject(new Error('EIO'))
      return Promise.resolve(sid === 'unreadable' ? null : new Set(['run1']))
    }
    expect(await sweep(journal, { protectedRuns })).toMatchObject({ pruned: 2 })
    expect(live(journal, 'named', 3)).toEqual([false, true, false])
    expect(live(journal, 'unreadable', 2)).toEqual([true, true])
    expect(live(journal, 'throws', 2)).toEqual([true, true])
    // A run the session starts naming after publication keeps its live journal beside the archive.
    const late = fixture()
    await runs(late, 'late', 1)
    let calls = 0
    expect(await sweep(late, { protectedRuns: () => Promise.resolve(new Set(++calls > 1 ? ['run0'] : [])) })).toMatchObject({ pruned: 0 })
    expect(fs.existsSync(late.archivePathFor('late', 'run0'))).toBe(true)
    expect(fs.existsSync(late.pathFor('late', 'run0'))).toBe(true)
    expect((await late.readRunEvents('late', 'run0')).length).toBe(3)
  })

  it('leaves files untouched on a dry run or with retention disabled', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'talaria-archive-'))
    const journal = fixture(dir)
    await runs(journal, 'session', 5)
    const before = fs.readdirSync(dir, { recursive: true }).sort()
    expect(await sweep(journal, { dryRun: true, maxRuns: 2 })).toMatchObject({ pruned: 5 })
    expect(await fixture(dir).pruneSettled({ now: Date.now() / 1000, retentionSeconds: 0, maxRuns: 1 })).toMatchObject({ pruned: 0 })
    expect(await new JsonJournal(dir, { HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS: '0' }).pruneSettled()).toMatchObject({ pruned: 0 })
    expect(fs.readdirSync(dir, { recursive: true }).sort()).toEqual(before)
  })

  it('skips archival on a platform without symlink-safe opens', async () => {
    const real = await vi.importActual<typeof fs>('node:fs')
    const constants = Object.fromEntries(Object.entries(real.constants).filter(([name]) => name !== 'O_NOFOLLOW'))
    vi.resetModules()
    vi.doMock('node:fs', () => ({ ...real, constants }))
    try {
      const { JsonJournal: Unsafe } = await import('./json-journal.js')
      const dir = fs.mkdtempSync(join(tmpdir(), 'talaria-archive-'))
      dirs.push(dir)
      const journal = new Unsafe(dir)
      await writeRun(journal, 'session', 'run')
      expect(await journal.pruneSettled({ now: Date.now() / 1000, retentionSeconds: 1, keepRecent: 0 })).toMatchObject({ pruned: 0 })
      expect(fs.existsSync(journal.pathFor('session', 'run'))).toBe(true)
      expect((await journal.readRunEvents('session', 'run')).length).toBe(3)
      await journal.close()
    } finally { vi.doUnmock('node:fs'); vi.resetModules() }
  })

  it('removes the oldest archives past the instance archive budget, keeping their summaries', async () => {
    const journal = fixture()
    for (const [i, sid] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      await writeRun(journal, sid, 'run', { text: `${sid} `.repeat(4000) })
      await sweep(journal)
      // Archives are published in order a..e; set their ages explicitly so the order is deterministic.
      fs.utimesSync(journal.archivePathFor(sid, 'run'), old + i, old + i)
    }
    const size = (sid: string): number => fs.statSync(journal.archivePathFor(sid, 'run')).size
    // `b` gained a live continuation, which still needs its archived prefix; `c` lost its summary.
    const writer = await journal.writer('b', 'run')
    await writer.appendSseEvent('token', { text: 'continuation' })
    await writer.close()
    fs.rmSync(join(journal.root(), 'c', 'run.summary.json'))
    const budget = size('d') + size('e')
    const before = fs.readdirSync(journal.sessionDir, { recursive: true }).sort()
    expect(await sweep(journal, { retentionSeconds: 365 * DAY, maxArchiveBytes: budget, dryRun: true })).toMatchObject({ archives_removed: 3 })
    expect(fs.readdirSync(journal.sessionDir, { recursive: true }).sort(), 'a dry run removes nothing').toEqual(before)
    expect(await sweep(journal, { retentionSeconds: 365 * DAY, maxArchiveBytes: 0 }), 'zero turns the budget off').toMatchObject({ archives_removed: 0 })
    expect(await sweep(journal, { retentionSeconds: 365 * DAY, maxArchiveBytes: budget })).toMatchObject({ archives_removed: 3 })
    expect(['a', 'b', 'c', 'd', 'e'].map((sid) => fs.existsSync(journal.archivePathFor(sid, 'run')))).toEqual([false, true, true, false, false])
    // The removed run reads as pruned history: its summary stays and replay honestly reports it unavailable.
    expect(await journal.findRunSummary('run')).toBeTruthy()
    expect(await journal.latestRunSummary('a', 'run')).toMatchObject({ journal_pruned: true, terminal: true, last_seq: 3 })
    expect(await journal.readRunEvents('a', 'run')).toEqual([])
    expect((await journal.readSessionRunEvents('a', 'run:1')).status).toBe('cursor_pruned')
    expect((await journal.readRunEvents('b', 'run')).map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('reads its caps once from the server environment, disabling any it cannot parse', () => {
    expect(retentionPolicy({})).toEqual({ retentionSeconds: 14 * DAY, keepRecent: 3, maxRuns: 40, maxBytes: 256 * 1024 * 1024, maxArchiveBytes: 2 * 1024 * 1024 * 1024 })
    expect(retentionPolicy({ HERMES_WEBUI_RUN_JOURNAL_ARCHIVE_MAX_BYTES: '0' }).maxArchiveBytes, 'zero turns the archive budget off').toBe(0)
    expect(retentionPolicy({ HERMES_WEBUI_RUN_JOURNAL_ARCHIVE_MAX_BYTES: '2GB' }).maxArchiveBytes, 'an invalid budget never removes archives').toBe(0)
    expect(retentionPolicy({ HERMES_WEBUI_RUN_JOURNAL_ARCHIVE_MAX_BYTES: '1048576' }).maxArchiveBytes).toBe(1048576)
    const caps = (runsValue: string, bytesValue: string) => {
      const { maxRuns, maxBytes } = retentionPolicy({ HERMES_WEBUI_RUN_JOURNAL_RETENTION_MAX_RUNS_PER_SESSION: runsValue, HERMES_WEBUI_RUN_JOURNAL_RETENTION_MAX_BYTES_PER_SESSION: bytesValue })
      return [maxRuns, maxBytes]
    }
    expect(caps('7', ' 1024 ')).toEqual([7, 1024])
    expect(caps('0', '0'), 'zero disables each cap').toEqual([0, 0])
    for (const invalid of ['-1', '1.5', 'ten', '1e3', '100001']) expect(caps(invalid, invalid), invalid).toEqual([0, invalid === '100001' ? 100001 : 0])
    expect(caps('', '')).toEqual([40, 256 * 1024 * 1024])
    expect(retentionPolicy({ HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS: '0', HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT: '5' })).toMatchObject({ retentionSeconds: 0, keepRecent: 5 })
  })

  it('reads session references through the session backend', async () => {
    const docs: Record<string, unknown> = { active: { doc: { active_stream_id: ' run1 ' } }, idle: { doc: { active_stream_id: null } } }
    const references = sessionRunReferences({ readDocument: (sid) => sid === 'broken' ? Promise.reject(new SyntaxError('Unexpected token')) : Promise.resolve((docs[sid] ?? null) as never) })
    expect(await references('active')).toEqual(new Set(['run1']))
    expect(await references('idle')).toEqual(new Set())
    expect(await references('missing'), 'a journal without a session document names nothing').toEqual(new Set())
    expect(await references('owner.with.dots'), 'no session document can have an unsafe id').toEqual(new Set())
    expect(await references('broken')).toBeNull()
  })
})
