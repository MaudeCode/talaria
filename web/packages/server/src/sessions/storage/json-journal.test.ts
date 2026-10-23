import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonJournal } from './json-journal.js'

vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, readdirSync: vi.fn(real.readdirSync), existsSync: vi.fn(real.existsSync), mkdirSync: vi.fn(real.mkdirSync), fsync: vi.fn(real.fsync), closeSync: vi.fn(real.closeSync) }
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
  expect(fs.readdirSync).not.toHaveBeenCalled()
  expect(vi.mocked(fs.existsSync).mock.calls.length).toBeLessThanOrEqual(20)
  expect(vi.mocked(fs.existsSync).mock.calls.every(([path]) => dirname(String(path)) === join(journal.root(), sid))).toBe(true)
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

it('does not cache misses and rediscovers disappeared, moved and recreated runs', async () => {
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

it('keeps pruned summaries warm and fresh, and rediscovers their moves and replacements', async () => {
  const journal = fixture()
  await writeRun(journal, 'session')
  const original = await journal.findRunSummary('run')
  expect(original).toMatchObject({ journal_truncated: false, terminal: true })
  expect((await journal.pruneSettled({ now: Date.now() / 1000 + 10, retentionSeconds: 1, keepRecent: 0 })).pruned).toBe(1)
  for (let i = 0; i < 100; i++) fs.mkdirSync(join(journal.root(), `unrelated${i}`))
  vi.clearAllMocks()
  const pruned = await journal.findRunSummary('run')
  expect(pruned).toMatchObject({ journal_pruned: true, terminal: true, path: join(journal.root(), 'session/run.summary.json') })
  expect(fs.readdirSync).not.toHaveBeenCalled()
  fs.writeFileSync(pruned!.path!, JSON.stringify({ ...pruned, last_seq: 9, event_count: 9 }))
  expect(await journal.findRunSummary('run')).toMatchObject({ last_seq: 9, event_count: 9 })
  fs.renameSync(join(journal.root(), 'session'), join(journal.root(), 'moved'))
  const movedPath = join(journal.root(), 'moved/run.summary.json')
  expect(await journal.findRunSummary('run')).toMatchObject({ path: movedPath, last_seq: 9 })
  vi.clearAllMocks()
  expect(await journal.findRunSummary('run')).toMatchObject({ path: movedPath })
  expect(fs.readdirSync).not.toHaveBeenCalled()
  expect(vi.mocked(fs.existsSync).mock.calls.every(([path]) => dirname(String(path)) === join(journal.root(), 'moved'))).toBe(true)
  fs.writeFileSync(movedPath, 'broken JSON')
  expect(await journal.findRunSummary('run')).toBeNull()
  await writeRun(journal, 'replacement')
  expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 'replacement', last_seq: 1 })
})

it('prefers a recreated journal over a warm pruned summary', async () => {
  const journal = fixture()
  await writeRun(journal, 'session')
  await journal.pruneSettled({ now: Date.now() / 1000 + 10, retentionSeconds: 1, keepRecent: 0 })
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
    await writeRun(journal, 'session')
    vi.clearAllMocks()
    expect(await journal.findRunSummary('run')).toMatchObject({ session_id: 'session' })
    expect(fs.readdirSync).toHaveBeenCalledTimes(1)
  }
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
  expect(fs.existsSync).not.toHaveBeenCalled()
  expect(fs.readdirSync).not.toHaveBeenCalled()
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
  expect(fs.readdirSync).not.toHaveBeenCalled()
  expect(await journal.findRunSummary('run1')).toMatchObject({ run_id: 'run1' })
  expect(fs.readdirSync).toHaveBeenCalledTimes(1)
  await journal.close()
  vi.clearAllMocks()
  for (let i = 0; i < 2; i++) expect(await journal.findRunSummary('run0')).toMatchObject({ run_id: 'run0' })
  expect(fs.readdirSync).toHaveBeenCalledTimes(2)
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

it('settles a terminal append only after its fsync completes, before closing the file', async () => {
  const journal = fixture()
  const writer = await journal.writer('session', 'run')
  await writer.appendSseEvent('token', { text: 'first' })
  expect(fs.fsync).not.toHaveBeenCalled()
  let finish: (() => void) | undefined
  vi.mocked(fs.fsync).mockImplementationOnce((fd: number, cb: (err: NodeJS.ErrnoException | null) => void) => { finish = () => { fs.fsyncSync(fd); cb(null) } })
  const order: string[] = []
  const terminal = writer.appendSseEvent('cancel', {}).then(() => order.push('published'))
  await new Promise((resolve) => setImmediate(resolve))
  expect(fs.fsync).toHaveBeenCalledTimes(1)
  expect(order).toEqual([])
  expect(fs.closeSync).not.toHaveBeenCalled()
  order.push('synced')
  finish!()
  await terminal
  expect(order).toEqual(['synced', 'published'])
  expect(fs.closeSync).toHaveBeenCalledTimes(1)
  await writer.close()
})
