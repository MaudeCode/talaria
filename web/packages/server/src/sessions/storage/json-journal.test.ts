import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonJournal } from './json-journal.js'

vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, readdirSync: vi.fn(real.readdirSync), existsSync: vi.fn(real.existsSync) }
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
