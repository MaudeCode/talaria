import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PruneOptions } from '../journal.js'
import { SqliteStorage } from './sqlite.js'
import type { SqliteJournal } from './sqlite-journal.js'

const DAY = 86400
const old = Date.now() / 1000 - 30 * DAY
const stores: SqliteStorage[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function open(dir = mkdtempSync(join(tmpdir(), 'talaria-sqlite-archive-'))): { dir: string; storage: SqliteStorage; journal: SqliteJournal } {
  if (!dirs.includes(dir)) dirs.push(dir)
  const storage = new SqliteStorage({ path: join(dir, 'talaria.db'), sessionDir: join(dir, 'sessions'), stampingSince: () => 0 })
  stores.push(storage)
  return { dir, storage, journal: storage.journals }
}
const sql = (storage: SqliteStorage) => storage.db.db

/** Large Unicode text with the raw separators a line splitter other than `\n` would break on. */
const UNICODE = `🌲 é 中文 \u0085     `.repeat(12_000)

async function writeRun(storage: SqliteStorage, sid: string, rid: string, opts: { written?: number; terminal?: boolean; text?: string } = {}): Promise<void> {
  const writer = await storage.journals.writer(sid, rid)
  await writer.appendSseEvent('token', { text: opts.text ?? 'hi' })
  await writer.appendSseEvent('tool', { name: 'read', tid: 't1' })
  if (opts.terminal ?? true) await writer.appendSseEvent('done', { session_id: sid })
  await writer.close()
  sql(storage).prepare('UPDATE journal_rows SET written_at = ? WHERE session_id = ? AND stream_id = ?').run(opts.written ?? old, sid, rid)
}
const liveRows = (storage: SqliteStorage, sid: string, rid: string): number => (sql(storage).prepare('SELECT count(*) AS n FROM journal_rows WHERE session_id = ? AND stream_id = ?').get(sid, rid) as { n: number }).n
const archived = (storage: SqliteStorage, sid: string, rid: string): boolean => Boolean(sql(storage).prepare('SELECT 1 AS present FROM journal_archives WHERE session_id = ? AND stream_id = ?').get(sid, rid))

/** Everything a reader observes about a run and its session. */
async function observe(journal: SqliteJournal, sid: string, rid: string) {
  const replay = await journal.readSessionRunEvents(sid, `${rid}:1`)
  return {
    rows: await journal.readRunEvents(sid, rid),
    after: await journal.readRunEvents(sid, rid, { afterSeq: 1, maxSeq: 2 }),
    tail: await journal.readRunEventTail(sid, rid, 1024, 2),
    found: await journal.findRunSummary(rid),
    latest: await journal.latestRunSummary(sid, rid),
    replay: { status: replay.status, events: replay.events },
    missing: (await journal.readSessionRunEvents(sid, `${rid}:99`)).status,
    streams: await journal.streams(sid),
  }
}

const sweep = (journal: SqliteJournal, opts: PruneOptions = {}) => journal.pruneSettled({ now: Date.now() / 1000, retentionSeconds: 14 * DAY, keepRecent: 0, maxRuns: 0, maxBytes: 0, ...opts })

describe('SQLite run-journal archival', () => {
  it.each([
    ['age', {}],
    ['count', { retentionSeconds: 365 * DAY, maxRuns: 1 }],
    ['bytes', { retentionSeconds: 365 * DAY, maxBytes: 8192 }],
  ] as const)('a run archived by %s replays identically, before and after reopening the database', async (_reason, opts) => {
    const { dir, storage, journal } = open()
    await writeRun(storage, 'session', 'run', { text: UNICODE })
    await writeRun(storage, 'session', 'next', { written: Date.now() / 1000, text: 'x'.repeat(2048) })
    const original = (sql(storage).prepare("SELECT row FROM journal_rows WHERE stream_id = 'run' ORDER BY seq").all() as { row: string }[]).map(({ row }) => `${row}\n`).join('')
    const before = await observe(journal, 'session', 'run')
    expect(before.rows.map((e) => e.event_id)).toEqual(['run:1', 'run:2', 'run:3'])
    expect(before.replay.status).toBe('ok')
    expect(await sweep(journal, opts)).toMatchObject({ pruned: 1, bytes_reclaimed: Buffer.byteLength(original) })
    expect(liveRows(storage, 'session', 'run')).toBe(0)
    expect(liveRows(storage, 'session', 'next'), 'only the due run is archived').toBe(3)
    const blob = sql(storage).prepare("SELECT rows FROM journal_archives WHERE stream_id = 'run'").get() as { rows: Uint8Array }
    expect(gunzipSync(blob.rows).toString('utf8'), 'the archive repeats the rows byte for byte').toBe(original)
    expect(await observe(journal, 'session', 'run')).toEqual(before)
    await storage.close()
    expect(await observe(open(dir).journal, 'session', 'run'), 'a reopened database reads the same run').toEqual(before)
  })

  it('keeps a reader that is part way through a run reading it while retention archives it', async () => {
    const { storage, journal } = open()
    const writer = await journal.writer('session', 'run')
    for (let i = 0; i < 600; i += 1) await writer.appendSseEvent('token', { i })
    await writer.appendSseEvent('done', {})
    await writer.close()
    sql(storage).prepare('UPDATE journal_rows SET written_at = ?').run(old)
    const reader = journal.iterRunEvents('session', 'run')
    const first = await reader.next()
    const seqs = [first.done ? 0 : first.value.seq]
    expect(await sweep(journal)).toMatchObject({ pruned: 1 })
    for await (const event of reader) seqs.push(event.seq)
    expect(seqs).toEqual(Array.from({ length: 601 }, (_, i) => i + 1))
  })

  it('continues the sequence when a writer reopens an archived run, and never trims the prefix it needs', async () => {
    const { storage, journal } = open()
    await writeRun(storage, 'session', 'run')
    await sweep(journal)
    const writer = await journal.writer('session', 'run')
    expect(await writer.appendSseEvent('token', { text: 'continuation' })).toMatchObject({ seq: 4, event_id: 'run:4' })
    await writer.close()
    expect((await journal.readRunEvents('session', 'run')).map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect((await journal.readRunEvents('session', 'run', { afterSeq: 2 })).map((e) => e.seq)).toEqual([3, 4])
    expect(await sweep(journal, { maxArchiveBytes: 1 })).toMatchObject({ archives_removed: 0 })
    expect((await journal.readRunEvents('session', 'run')).map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('answers lookups of an archived run from its stored summary, and refuses an archive it cannot inflate', async () => {
    const { storage, journal } = open()
    await writeRun(storage, 'session', 'run')
    const before = await journal.latestRunSummary('session', 'run')
    await sweep(journal)
    sql(storage).prepare("UPDATE journal_archives SET rows = X'00'").run()
    expect(await journal.latestRunSummary('session', 'run')).toEqual(before)
    expect(await journal.findRunSummary('run')).toEqual(before)
    await expect(journal.readRunEvents('session', 'run')).rejects.toThrow('unreadable')
    expect((await journal.readSessionRunEvents('session', 'run:1')).status).toBe('replay_unreadable')
  })

  it('stops a session replay at its byte budget before assembling an archived row', async () => {
    const { storage, journal } = open()
    await writeRun(storage, 'session', 'run', { text: 'x'.repeat(6 * 1024 * 1024) })
    await sweep(journal)
    // Understate the stored size so the replay reaches the archive instead of refusing up front.
    sql(storage).prepare('UPDATE journal_archives SET bytes = 1').run()
    const concat = vi.spyOn(Buffer, 'concat')
    expect((await journal.readSessionRunEvents('session', 'run:1')).status).toBe('replay_limit_bytes')
    const largest = Math.max(0, ...concat.mock.results.map((r) => (r.value as Buffer).length))
    expect(largest, 'no buffer past the 4 MiB replay budget').toBeLessThanOrEqual(4 * 1024 * 1024)
  })

  it('deletes archives with their session', async () => {
    const { storage, journal } = open()
    await writeRun(storage, 'session', 'run')
    await sweep(journal)
    expect(await journal.deleteSession('session')).toBe(true)
    expect(archived(storage, 'session', 'run')).toBe(false)
    expect(await journal.readRunEvents('session', 'run')).toEqual([])
    expect(await journal.findRunSummary('run')).toBeNull()
    expect(await journal.streams('session')).toEqual([])
  })
})

describe('SQLite retention budgets and protection', () => {
  const runs = async (storage: SqliteStorage, sid: string, count: number, written = old): Promise<void> => {
    for (let i = 0; i < count; i += 1) await writeRun(storage, sid, `run${String(i)}`, { written: written + i })
  }
  const live = (storage: SqliteStorage, sid: string, count: number): boolean[] => [...Array(count).keys()].map((i) => liveRows(storage, sid, `run${String(i)}`) > 0)

  it('archives the oldest runs past a soft budget, above the keep-recent floor', async () => {
    const { storage, journal } = open()
    const fresh = Date.now() / 1000 - 60
    await runs(storage, 'count', 6, fresh)
    await writeRun(storage, 'count', 'open', { terminal: false, written: fresh - 10 })
    expect(await sweep(journal, { maxRuns: 4, keepRecent: 1 })).toMatchObject({ pruned: 3 })
    expect(live(storage, 'count', 6), 'the oldest settled runs go first').toEqual([false, false, false, true, true, true])
    expect(liveRows(storage, 'count', 'open'), 'a nonterminal run is never archived').toBe(2)
    // The keep-recent floor wins over the budget, which stays soft.
    const floor = open()
    await runs(floor.storage, 'floor', 5, fresh)
    expect(await sweep(floor.journal, { maxRuns: 1, keepRecent: 3 })).toMatchObject({ pruned: 2 })
    expect(live(floor.storage, 'floor', 5)).toEqual([false, false, true, true, true])
    // Bytes: archive until the session's live bytes fit.
    const bytes = open()
    await runs(bytes.storage, 'bytes', 4, fresh)
    const each = (sql(bytes.storage).prepare("SELECT sum(length(CAST(row AS BLOB)) + 1) AS n FROM journal_rows WHERE stream_id = 'run0'").get() as { n: number }).n
    expect(await sweep(bytes.journal, { maxBytes: each * 2 + 64 })).toMatchObject({ pruned: 2 })
    expect(live(bytes.storage, 'bytes', 4)).toEqual([false, false, true, true])
  })

  it('keeps runs the session still names, and whole sessions whose state is unreadable', async () => {
    const { storage, journal } = open()
    await runs(storage, 'named', 3)
    await runs(storage, 'unreadable', 2)
    await runs(storage, 'throws', 2)
    const protectedRuns = (sid: string): Promise<Set<string> | null> => {
      if (sid === 'throws') return Promise.reject(new Error('EIO'))
      return Promise.resolve(sid === 'unreadable' ? null : new Set(['run1']))
    }
    expect(await sweep(journal, { protectedRuns })).toMatchObject({ pruned: 2 })
    expect(live(storage, 'named', 3)).toEqual([false, true, false])
    expect(live(storage, 'unreadable', 2)).toEqual([true, true])
    expect(live(storage, 'throws', 2)).toEqual([true, true])
    // A run the session starts naming while it is compacted stays live, with no archive.
    const late = open()
    await runs(late.storage, 'late', 1)
    let calls = 0
    expect(await sweep(late.journal, { protectedRuns: () => Promise.resolve(new Set(++calls > 1 ? ['run0'] : [])) })).toMatchObject({ pruned: 0 })
    expect(live(late.storage, 'late', 1)).toEqual([true])
    expect(archived(late.storage, 'late', 'run0')).toBe(false)
  })

  it('changes nothing on a dry run or with retention disabled', async () => {
    const { storage, journal } = open()
    await runs(storage, 'session', 5)
    expect(await sweep(journal, { dryRun: true, maxRuns: 2 })).toMatchObject({ pruned: 5 })
    expect(await journal.pruneSettled({ now: Date.now() / 1000, retentionSeconds: 0, maxRuns: 1 })).toMatchObject({ pruned: 0 })
    expect(live(storage, 'session', 5)).toEqual([true, true, true, true, true])
  })

  it('removes the oldest archives past the instance archive budget, keeping their summaries', async () => {
    const { storage, journal } = open()
    for (const [i, sid] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      await writeRun(storage, sid, 'run', { text: `${sid} `.repeat(4000) })
      await sweep(journal)
      sql(storage).prepare('UPDATE journal_archives SET archived_at = ? WHERE session_id = ?').run(old + i, sid)
    }
    const size = (sid: string): number => (sql(storage).prepare("SELECT length(rows) AS n FROM journal_archives WHERE session_id = ? AND stream_id = 'run'").get(sid) as { n: number }).n
    // `b` gained a live continuation, which still needs its archived prefix; `c` lost its summary.
    const writer = await journal.writer('b', 'run')
    await writer.appendSseEvent('token', { text: 'continuation' })
    await writer.close()
    sql(storage).prepare("DELETE FROM journal_summaries WHERE session_id = 'c'").run()
    const budget = size('d') + size('e')
    const all = () => ['a', 'b', 'c', 'd', 'e'].map((sid) => archived(storage, sid, 'run'))
    const year = { retentionSeconds: 365 * DAY }
    expect(await sweep(journal, { ...year, maxArchiveBytes: budget, dryRun: true })).toMatchObject({ archives_removed: 3 })
    expect(all(), 'a dry run removes nothing').toEqual([true, true, true, true, true])
    expect(await sweep(journal, { ...year, maxArchiveBytes: 0 }), 'zero turns the budget off').toMatchObject({ archives_removed: 0 })
    expect(await sweep(journal, { ...year, maxArchiveBytes: budget })).toMatchObject({ archives_removed: 3 })
    expect(all()).toEqual([false, true, true, false, false])
    // The removed run reads as pruned history: its summary stays and replay honestly reports it unavailable.
    expect(await journal.latestRunSummary('a', 'run')).toMatchObject({ journal_pruned: true, terminal: true, last_seq: 3 })
    expect(await journal.readRunEvents('a', 'run')).toEqual([])
    expect((await journal.readSessionRunEvents('a', 'run:1')).status).toBe('cursor_pruned')
    expect((await journal.readRunEvents('b', 'run')).map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })
})
