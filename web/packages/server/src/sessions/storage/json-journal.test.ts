import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS, summaryFromTail } from '../journal.js'
import { JsonJournal } from './json-journal.js'

vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, readdirSync: vi.fn(real.readdirSync), existsSync: vi.fn(real.existsSync), mkdirSync: vi.fn(real.mkdirSync), fsync: vi.fn(real.fsync), closeSync: vi.fn(real.closeSync) }
})
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof fsp>()
  return { ...real, readdir: vi.fn(real.readdir), access: vi.fn(real.access) }
})

const journals: JsonJournal[] = []
function fixture(): JsonJournal {
  const journal = new JsonJournal(fs.mkdtempSync(join(tmpdir(), 'talaria-journal-lookup-')))
  journals.push(journal)
  return journal
}

afterEach(async () => {
  for (const journal of journals.splice(0)) {
    await journal.close()
    fs.rmSync(journal.sessionDir, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

async function writeRun(journal: JsonJournal, sid: string, rid = 'run'): Promise<void> {
  const writer = await journal.writer(sid, rid)
  await writer.appendSseEvent('done', { session_id: sid })
  await writer.close()
}

it.each([1, 100, 645, 1000])('warm lookup probes only its owner among %i session directories', async (count) => {
  const journal = fixture()
  for (let i = 0; i < count; i++) fs.mkdirSync(join(journal.root(), `s${String(i).padStart(4, '0')}`), { recursive: true })
  const sid = `s${String(count - 1).padStart(4, '0')}`
  await writeRun(journal, sid)
  expect(await journal.findRunSummary('run')).toMatchObject({ session_id: sid, terminal: true })
  vi.clearAllMocks()
  for (let i = 0; i < 10; i++) expect(await journal.findRunSummary('run')).toMatchObject({ session_id: sid, terminal: true })
  expect(fsp.readdir).not.toHaveBeenCalled()
  expect(vi.mocked(fsp.access).mock.calls.length).toBeLessThanOrEqual(20)
  expect(vi.mocked(fsp.access).mock.calls.every(([path]) => dirname(String(path)) === join(journal.root(), sid))).toBe(true)
})

it('reads fresh event and terminal metadata after appends and same-path replacement', async () => {
  const journal = fixture()
  const writer = await journal.writer('session', 'run')
  await writer.appendSseEvent('token', { text: 'first' })
  expect(await journal.findRunSummary('run')).toMatchObject({ last_seq: 1, terminal: false })
  await writer.appendSseEvent('done', {})
  expect(await journal.findRunSummary('run')).toMatchObject({ last_seq: 2, terminal: true, last_event: 'done' })
  await writer.close()
  fs.unlinkSync(journal.pathFor('session', 'run'))
  await writeRun(journal, 'session')
  expect(await journal.findRunSummary('run')).toMatchObject({ last_seq: 1, terminal: true })
})

it('an unknown run among 500 session directories never blocks the event loop and its miss is cached', async () => {
  const journal = fixture()
  for (let i = 0; i < 500; i++) fs.mkdirSync(join(journal.root(), `s${String(i).padStart(3, '0')}`), { recursive: true })
  vi.clearAllMocks()
  expect(await journal.findRunSummary('gone')).toBeNull()
  expect(fs.readdirSync).not.toHaveBeenCalled()
  expect(fs.existsSync).not.toHaveBeenCalled()
  vi.clearAllMocks()
  expect(await journal.findRunSummary('gone')).toBeNull()
  expect(fsp.readdir).not.toHaveBeenCalled()
  expect(fs.readdirSync).not.toHaveBeenCalled()
  expect(fs.existsSync).not.toHaveBeenCalled()
})

it('a run journal written by another process invalidates a cached miss', async () => {
  const journal = fixture()
  expect(await journal.findRunSummary('run')).toBeNull()
  const other = new JsonJournal(journal.sessionDir)
  await writeRun(other, 'elsewhere')
  await other.close()
  expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 'elsewhere', terminal: true })
})

it('never caches a miss for a run whose writer is open before its first row', async () => {
  const journal = fixture()
  // An earlier run already made the session directory, so the first row leaves the journals root unchanged.
  await writeRun(journal, 'session', 'earlier')
  const writer = await journal.writer('session', 'run')
  expect(await journal.findRunSummary('run')).toBeNull()
  await writer.appendSseEvent('token', { text: 'first' })
  expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 'session', last_seq: 1 })
  await writer.close()
})

it('a session hint resolves the run without probing other sessions', async () => {
  const journal = fixture()
  for (let i = 0; i < 50; i++) fs.mkdirSync(join(journal.root(), `s${String(i).padStart(2, '0')}`), { recursive: true })
  const other = new JsonJournal(journal.sessionDir)
  await writeRun(other, 's49')
  await other.close()
  vi.clearAllMocks()
  expect(await journal.findRunSummary('run', 's49')).toMatchObject({ session_id: 's49', terminal: true })
  expect(await journal.findRunSummary('missing', 's49')).toBeNull()
  expect(await journal.findRunSummary('run', 's00')).toBeNull()
  expect(fsp.readdir).not.toHaveBeenCalled()
  expect(fs.readdirSync).not.toHaveBeenCalled()
})

it('rediscovers disappeared, moved and recreated runs', async () => {
  const journal = fixture()
  expect(await journal.findRunSummary('run')).toBeNull()
  await writeRun(journal, 'first')
  expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 'first' })
  fs.renameSync(join(journal.root(), 'first'), join(journal.root(), 'second'))
  expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 'second' })
  fs.rmSync(join(journal.root(), 'second'), { recursive: true })
  expect(await journal.findRunSummary('run')).toBeNull()
  await writeRun(journal, 'third')
  expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 'third' })
})

/** Summary-only history, as releases before archival pruned it: the events are gone and only the summary remains. */
async function legacyPrune(journal: JsonJournal, sid: string): Promise<void> {
  expect((await journal.pruneSettled({ now: Date.now() / 1000 + 10, retentionSeconds: 1, keepRecent: 0 })).pruned).toBe(1)
  fs.rmSync(join(journal.root(), sid, '_archive'), { recursive: true })
}

it('keeps pruned summaries warm and fresh, and rediscovers their moves and replacements', async () => {
  const journal = fixture()
  await writeRun(journal, 'session')
  const original = await journal.findRunSummary('run')
  expect(original).toMatchObject({ journal_truncated: false, terminal: true })
  await legacyPrune(journal, 'session')
  for (let i = 0; i < 100; i++) fs.mkdirSync(join(journal.root(), `unrelated${i}`))
  vi.clearAllMocks()
  const pruned = await journal.findRunSummary('run')
  expect(pruned).toMatchObject({ journal_pruned: true, terminal: true, path: join(journal.root(), 'session/run.summary.json') })
  expect(fsp.readdir).not.toHaveBeenCalled()
  fs.writeFileSync(pruned!.path!, JSON.stringify({ ...pruned, last_seq: 9, event_count: 9 }))
  expect(await journal.findRunSummary('run')).toMatchObject({ last_seq: 9, event_count: 9 })
  fs.renameSync(join(journal.root(), 'session'), join(journal.root(), 'moved'))
  const movedPath = join(journal.root(), 'moved/run.summary.json')
  expect(await journal.findRunSummary('run')).toMatchObject({ path: movedPath, last_seq: 9 })
  vi.clearAllMocks()
  expect(await journal.findRunSummary('run')).toMatchObject({ path: movedPath })
  expect(fsp.readdir).not.toHaveBeenCalled()
  expect(vi.mocked(fsp.access).mock.calls.every(([path]) => dirname(String(path)) === join(journal.root(), 'moved'))).toBe(true)
  fs.writeFileSync(movedPath, 'broken JSON')
  expect(await journal.findRunSummary('run')).toBeNull()
  await writeRun(journal, 'replacement')
  expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 'replacement', last_seq: 1 })
})

it('prefers a recreated journal over a warm pruned summary', async () => {
  const journal = fixture()
  await writeRun(journal, 'session')
  await legacyPrune(journal, 'session')
  expect(await journal.findRunSummary('run')).toMatchObject({ journal_pruned: true })
  const writer = await journal.writer('session', 'run')
  await writer.appendSseEvent('token', { text: 'new run' })
  expect(await journal.findRunSummary('run')).toMatchObject({ terminal: false, last_event: 'token', path: journal.pathFor('session', 'run') })
  await writer.close()
})

it('continues at UTF-8 byte offsets and can catch a run created after the full replay', async () => {
  const journal = fixture()
  const writer = await journal.writer('session', 'run')
  await writer.appendSseEvent('token', { text: '🌲 é' })
  const replay = await journal.readSessionRunEvents('session', 'run:1')
  expect(replay.status).toBe('ok')
  expect(await replay.readActiveTail?.('run')).toMatchObject({ status: 'ok', events: [] })
  const second = await writer.appendSseEvent('token', { text: 'after the full read' })
  expect(await replay.readActiveTail?.('run')).toMatchObject({ status: 'ok', events: [second] })
  const next = await journal.writer('session', 'new-run')
  const first = await next.appendSseEvent('token', { text: 'new run' })
  expect(await replay.readActiveTail?.('new-run')).toMatchObject({ status: 'ok', events: [first] })
})

it.each(['replace', 'truncate', 'remove', 'malformed', 'gap', 'foreign'] as const)('rejects an unsafe active tail after %s', async (change) => {
  const journal = fixture()
  const writer = await journal.writer('session', 'run')
  const first = await writer.appendSseEvent('token', { text: 'first' })
  const replay = await journal.readSessionRunEvents('session', 'run:1')
  const path = journal.pathFor('session', 'run')
  await writer.close()
  if (change === 'replace') { fs.renameSync(path, path + '.old'); fs.writeFileSync(path, JSON.stringify(first) + '\n') }
  if (change === 'truncate') fs.truncateSync(path)
  if (change === 'remove') fs.unlinkSync(path)
  if (change === 'malformed') fs.appendFileSync(path, '{torn\n')
  if (change === 'gap' || change === 'foreign') fs.appendFileSync(path, JSON.stringify({ ...first, seq: change === 'gap' ? 3 : 2, event_id: change === 'gap' ? 'run:3' : 'run:2', session_id: change === 'foreign' ? 'another' : 'session' }) + '\n')
  const tail = await replay.readActiveTail?.('run')
  expect(tail?.status).toBe(change === 'malformed' ? 'replay_malformed' : change === 'gap' || change === 'foreign' ? 'replay_noncontiguous' : 'replay_changed')
  expect(tail?.events).toEqual([])
})

it.each(['bytes', 'rows'] as const)('shares the session replay %s limit with the active tail', async (limit) => {
  const journal = fixture()
  const writer = await journal.writer('session', 'run')
  if (limit === 'rows') {
    for (let i = 0; i < 4096; i++) await writer.appendSseEvent('token', {})
  } else await writer.appendSseEvent('token', { text: 'x'.repeat(4 * 1024 * 1024 - 1024) })
  const replay = await journal.readSessionRunEvents('session', 'run:1')
  expect(replay.status).toBe('ok')
  await writer.appendSseEvent('token', { text: 'x'.repeat(2048) })
  expect(await replay.readActiveTail?.('run')).toMatchObject({ status: `replay_limit_${limit}`, events: [] })
})

it('preserves cursor validation and missing/pruned/foreign snapshot reasons', async () => {
  const journal = fixture()
  await writeRun(journal, 'session')
  await writeRun(journal, 'other', 'foreign')
  fs.writeFileSync(join(journal.root(), 'session', 'pruned.summary.json'), '{}')
  for (const [cursor, status] of [
    ['', 'ok'], ['bad', 'cursor_invalid'], ['../run:1', 'cursor_invalid'],
    ['run:0', 'cursor_invalid'], ['run:2', 'cursor_event_missing'],
    ['missing:1', 'cursor_run_missing'], ['pruned:1', 'cursor_pruned'], ['foreign:1', 'cursor_session_mismatch'],
  ]) expect((await journal.readSessionRunEvents('session', cursor)).status).toBe(status)
})

it('invalidates session deletion, including an already removed directory', async () => {
  const journal = fixture()
  for (const removedExternally of [false, true]) {
    await writeRun(journal, 'session')
    expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 'session' })
    if (removedExternally) fs.rmSync(join(journal.root(), 'session'), { recursive: true })
    expect(await journal.deleteSession('session')).toBe(!removedExternally)
    vi.clearAllMocks()
    expect(await journal.findRunSummary('run')).toBeNull()
    expect(fsp.readdir).toHaveBeenCalledTimes(1)
    // A recreated run's writer records its owner again.
    await writeRun(journal, 'session')
    vi.clearAllMocks()
    expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 'session' })
    expect(fsp.readdir).not.toHaveBeenCalled()
  }
})

it('knows a run owner from its first writer, before any lookup', async () => {
  const journal = fixture()
  for (let i = 0; i < 200; i++) fs.mkdirSync(join(journal.root(), `s${String(i).padStart(3, '0')}`), { recursive: true })
  const writer = await journal.writer('s199', 'run')
  await writer.appendSseEvent('token', { text: 'live' })
  vi.clearAllMocks()
  expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 's199', terminal: false })
  expect(fsp.readdir).not.toHaveBeenCalled()
  await writer.close()
})

it('isolates identical run IDs in independent roots and rejects invalid IDs before I/O', async () => {
  const first = fixture()
  const second = fixture()
  await writeRun(first, 'first')
  await writeRun(second, 'second')
  fs.mkdirSync(join(first.root(), 'invalid session'))
  fs.writeFileSync(join(first.root(), 'invalid session/run.jsonl'), '{}\n')
  for (let i = 0; i < 2; i++) {
    expect(await first.findRunSummary('run')).toMatchObject({ session_id: 'first' })
    expect(await second.findRunSummary('run')).toMatchObject({ session_id: 'second' })
  }
  vi.clearAllMocks()
  for (const id of ['', '.', '..', '../run', '/run', 'run/other']) expect(await first.findRunSummary(id)).toBeNull()
  expect(fsp.access).not.toHaveBeenCalled()
  expect(fsp.readdir).not.toHaveBeenCalled()
})

it('evicts the least recently used owner above 1000 entries and releases ownership on close', async () => {
  const journal = fixture()
  for (let i = 0; i < 1000; i++) {
    await writeRun(journal, 'session', `run${i}`)
    expect(await journal.findRunSummary(`run${i}`)).toMatchObject({ session_id: 'session' })
  }
  await journal.findRunSummary('run0')
  await writeRun(journal, 'session', 'run1000')
  await journal.findRunSummary('run1000')
  vi.clearAllMocks()
  expect(await journal.findRunSummary('run0')).toMatchObject({ run_id: 'run0' })
  expect(fsp.readdir).not.toHaveBeenCalled()
  expect(await journal.findRunSummary('run1')).toMatchObject({ run_id: 'run1' })
  expect(fsp.readdir).toHaveBeenCalledTimes(1)
  await journal.close()
  vi.clearAllMocks()
  for (let i = 0; i < 2; i++) expect(await journal.findRunSummary('run0')).toMatchObject({ run_id: 'run0' })
  expect(fsp.readdir).toHaveBeenCalledTimes(2)
  await expect(journal.writer('session', 'another')).rejects.toThrow('Storage is closed')
})

it('creates the run directory once across 100 appends', async () => {
  const journal = fixture()
  const writer = await journal.writer('session', 'run')
  vi.clearAllMocks()
  for (let i = 0; i < 100; i++) await writer.appendSseEvent('token', { text: String(i) })
  expect(fs.mkdirSync).toHaveBeenCalledTimes(1)
  expect(await journal.readRunEvents('session', 'run')).toHaveLength(100)
  await writer.close()
})

it('settles a terminal append only after its fsync completes, before closing the file or settling later frames', async () => {
  const journal = fixture()
  const writer = await journal.writer('session', 'run')
  await writer.appendSseEvent('token', { text: 'first' })
  expect(fs.fsync).not.toHaveBeenCalled()
  let finish: (() => void) | undefined
  vi.mocked(fs.fsync).mockImplementationOnce((fd: number, cb: (err: NodeJS.ErrnoException | null) => void) => { finish = () => { fs.fsyncSync(fd); cb(null) } })
  const order: string[] = []
  const terminal = writer.appendSseEvent('cancel', {}).then(() => order.push('published'))
  const later = writer.appendSseEvent('token', { text: 'late' }).then(() => order.push('later'))
  await new Promise((resolve) => setImmediate(resolve))
  expect(fs.fsync).toHaveBeenCalledTimes(1)
  expect(order).toEqual([])
  expect(fs.closeSync).not.toHaveBeenCalled()
  order.push('synced')
  finish!()
  await Promise.all([terminal, later])
  expect(order).toEqual(['synced', 'published', 'later'])
  expect(fs.closeSync).toHaveBeenCalledTimes(1)
  await writer.close()
})

it('keeps a settled run replayable after retention archives it', async () => {
  const journal = fixture()
  const writer = await journal.writer('session', 'run')
  await writer.appendSseEvent('token', { text: 'kept after retention' })
  await writer.appendSseEvent('done', { session_id: 'session' })
  await writer.close()
  const before = await journal.readRunEvents('session', 'run')
  expect((await journal.pruneSettled({ now: Date.now() / 1000 + 10, retentionSeconds: 1, keepRecent: 0 })).pruned).toBe(1)
  expect(fs.existsSync(journal.pathFor('session', 'run')), 'the live journal is reclaimed').toBe(false)
  expect(await journal.readRunEvents('session', 'run'), 'retention keeps every replayable event').toEqual(before)
})

describe('run summary reads', () => {
  const KIB = 1024
  const pad = (bytes: number): { text: string } => ({ text: 'x'.repeat(bytes) })
  /** `rows` tokens of about `bytes` each, then `tail` in order. */
  async function writeLong(journal: JsonJournal, rows: number, bytes: number, tail: [string, unknown][], close = true): Promise<Awaited<ReturnType<JsonJournal['writer']>>> {
    const writer = await journal.writer('session', 'run')
    for (let i = 0; i < rows; i++) await writer.appendSseEvent('token', pad(bytes))
    for (const [event, payload] of tail) await writer.appendSseEvent(event, payload)
    if (close) await writer.close()
    return writer
  }
  /** The summary and the bytes its read requested from the journal's file handles. */
  async function measured(journal: JsonJournal): Promise<{ summary: Awaited<ReturnType<JsonJournal['latestRunSummary']>>; requested: number }> {
    const probe = await fsp.open(journal.pathFor('session', 'run'), 'r')
    const read = vi.spyOn(Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => unknown }, 'read')
    await probe.close()
    try {
      const summary = await journal.latestRunSummary('session', 'run')
      return { summary, requested: read.mock.calls.reduce((total, call) => total + Number(call[2]), 0) }
    } finally { read.mockRestore() }
  }
  const fullRead = async (journal: JsonJournal): Promise<ReturnType<typeof summaryFromTail>> =>
    summaryFromTail('session', 'run', await journal.readRunEventTail('session', 'run', RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS))

  it.each([
    ['3 MiB of few rows', 30, 100 * KIB, false],
    ['3 MiB past the row cap', 600, 5 * KIB, true],
    ['past the byte cap', 50, 100 * KIB, true],
  ] as const)('reads at most 64 KiB when the tail holds the terminal row, and summarizes like a full read: %s', async (_name, rows, bytes, truncated) => {
    const journal = fixture()
    await writeLong(journal, rows, bytes, [['token', pad(9 * KIB)], ['done', { terminal_state: 'no_response' }], ['stream_end', {}]])
    const { summary, requested } = await measured(journal)
    expect(requested).toBeLessThanOrEqual(64 * KIB)
    expect(summary).toEqual(await fullRead(journal))
    expect(summary).toMatchObject({ terminal: true, terminal_state: 'errored', last_event: 'stream_end', last_seq: rows + 3, journal_truncated: truncated })
  })

  it.each([
    ['stream_end is the only terminal row', [['stream_end', {}]], 'completed'],
    ['the authoritative row sits past the first read', [['done', { terminal_state: 'no_response' }], ['token', pad(70 * KIB)], ['stream_end', {}]], 'errored'],
  ] as const)('widens when %s', async (_name, tail, state) => {
    const journal = fixture()
    await writeLong(journal, 30, 100 * KIB, [...tail] as [string, unknown][])
    const { summary, requested } = await measured(journal)
    expect(requested).toBeGreaterThan(64 * KIB)
    expect(summary).toEqual(await fullRead(journal))
    expect(summary).toMatchObject({ terminal: true, terminal_state: state, last_event: 'stream_end' })
  })

  it('widens when no row fits the first read', async () => {
    const journal = fixture()
    const writer = await writeLong(journal, 30, 100 * KIB, [['token', pad(70 * KIB)]], false)
    const { summary } = await measured(journal)
    expect(summary).toEqual(await fullRead(journal))
    expect(summary).toMatchObject({ terminal: false, last_seq: 31, event_count: 31 })
    await writer.close()
  })

  it('reads at most 64 KiB for a run its open writer has not settled', async () => {
    const journal = fixture()
    const writer = await writeLong(journal, 30, 100 * KIB, [['token', pad(1 * KIB)]], false)
    const { summary, requested } = await measured(journal)
    expect(requested).toBeLessThanOrEqual(64 * KIB)
    expect(summary).toEqual(await fullRead(journal))
    expect(summary).toMatchObject({ terminal: false, terminal_state: 'running', last_seq: 31 })
    await writer.close()
  })

  // A `done` row carries a transcript window, so title frames can follow one the first read cuts in half.
  it.each([
    ['a worker that died before stream_end', true],
    ['a worker still writing title frames', false],
  ] as const)('keeps the terminal state of a done row past the first read with %s', async (_name, close) => {
    const journal = fixture()
    const writer = await writeLong(journal, 30, 100 * KIB, [['done', { terminal_state: 'no_response', session: pad(100 * KIB) }], ['title', { title: 'Named' }]], close)
    const { summary } = await measured(journal)
    expect(summary).toEqual(await fullRead(journal))
    expect(summary).toMatchObject({ terminal: true, terminal_state: 'errored', last_event: 'title' })
    await writer.close()
  })
})
