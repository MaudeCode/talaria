import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PruneOptions } from '../journal.js'
import { keepRecent } from '../../test/storage.js'
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
  const storage = new SqliteStorage({ path: join(dir, 'talaria.db'), sessionDir: join(dir, 'sessions'), env: keepRecent(0), stampingSince: () => 0 })
  stores.push(storage)
  return { dir, storage, journal: storage.journals }
}
const sql = (storage: SqliteStorage) => storage.db.db


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

const sweep = (journal: SqliteJournal, opts: PruneOptions = {}) => journal.pruneSettled({ now: Date.now() / 1000, retentionSeconds: 14 * DAY, maxRuns: 0, maxBytes: 0, ...opts })

describe('SQLite run-journal archival', () => {
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

  it('keeps a malformed row through archival, and the replay status it produces', async () => {
    const { storage, journal } = open()
    await writeRun(storage, 'session', 'run')
    sql(storage).prepare("INSERT INTO journal_rows (session_id, stream_id, seq, row, written_at) VALUES ('session', 'run', 4, '{torn', ?)").run(old)
    const before = await observe(journal, 'session', 'run')
    expect(before.replay.status).toBe('replay_malformed')
    expect(await sweep(journal)).toMatchObject({ pruned: 1 })
    expect(await observe(journal, 'session', 'run')).toEqual(before)
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

  it('changes nothing with retention disabled', async () => {
    const { storage, journal } = open()
    await runs(storage, 'session', 5)
    expect(await journal.pruneSettled({ now: Date.now() / 1000, retentionSeconds: 0, maxRuns: 1 })).toMatchObject({ pruned: 0 })
    expect(live(storage, 'session', 5)).toEqual([true, true, true, true, true])
  })
})

it('a session restriction finds its own run when another session holds the same run ID', async () => {
  const { storage, journal } = open()
  await writeRun(storage, 'first', 'run')
  await writeRun(storage, 'second', 'run')
  expect(await journal.findRunSummary('run', 'second')).toMatchObject({ session_id: 'second', run_id: 'run' })
  expect(await journal.findRunSummary('run', 'first')).toMatchObject({ session_id: 'first', run_id: 'run' })
  expect(await journal.findRunSummary('run', 'third')).toBeNull()
})
