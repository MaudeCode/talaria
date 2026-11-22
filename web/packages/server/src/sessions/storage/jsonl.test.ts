import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../session.js'
import type { SessionChange } from './backend.js'
import { runSessionBackendConformance } from './conformance.js'
import { JsonlStorage } from './jsonl.js'
import { sessionSearchTerms } from './search-text.js'

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof fsp>()
  return { ...real, open: vi.fn(real.open), rename: vi.fn(real.rename) }
})
const realOpen = (await vi.importActual<typeof fsp>('node:fs/promises')).open

function storage(stateDir: string): JsonlStorage {
  return new JsonlStorage({ directory: join(stateDir, 'sessions-jsonl'), sessionDir: join(stateDir, 'sessions'), stateDir, now: () => 1000, stampingSince: () => 0 })
}
/** Fails the next rename onto a `meta.json`: everything the write staged is on disk, and the commit never happens. */
const failNextCommit = (): void => { vi.mocked(fsp.rename).mockImplementationOnce((_from, to) => Promise.reject(new Error(`injected crash before renaming onto ${String(to)}`))) }

runSessionBackendConformance('JSONL', () => {
  const stateDir = fs.mkdtempSync(join(tmpdir(), 'talaria-jsonl-conformance-'))
  return { storage: storage(stateDir), failNextWrite: failNextCommit, cleanup: () => { fs.rmSync(stateDir, { recursive: true, force: true }) } }
})

const opened: JsonlStorage[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.mocked(fsp.open).mockImplementation(realOpen)
  vi.mocked(fsp.rename).mockReset().mockImplementation((await vi.importActual<typeof fsp>('node:fs/promises')).rename)
  for (const store of opened.splice(0)) await store.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const stateDir = fs.mkdtempSync(join(tmpdir(), 'talaria-jsonl-'))
  dirs.push(stateDir)
  /** A store over the same files, as a server restarted after the crash opens them. */
  const open = (): JsonlStorage => { const store = storage(stateDir); opened.push(store); return store }
  return { stateDir, open, session: join(stateDir, 'sessions-jsonl', 'chat') }
}
const rows = (count: number, from = 0): Message[] => Array.from({ length: count }, (_, n) => ({ role: (from + n) % 2 ? 'assistant' : 'user', content: `row ${String(from + n)} É漢 ${'x'.repeat((from + n) % 7)}` }))
const doc = { session_id: 'chat', title: 'Synthetic', updated_at: 100, message_count: 0 }
const write = (store: JsonlStorage, messages: SessionChange['messages'], expected: string | null) => store.sessions.write('chat', { doc, messages }, expected)
const lineBytes = (messages: Message[]): number => messages.reduce((sum, row) => sum + Buffer.byteLength(`${JSON.stringify(row)}\n`), 0)

describe('crash recovery', () => {
  /** Fails the first `open` of a path ending in `suffix`, so the write stops right before it. */
  const failOpening = (suffix: string): void => {
    vi.mocked(fsp.open).mockImplementation((path, ...rest) => {
      if (String(path).includes(suffix)) { vi.mocked(fsp.open).mockImplementation(realOpen); return Promise.reject(new Error(`injected crash opening ${String(path)}`)) }
      return realOpen(path, ...rest)
    })
  }
  it.each([
    ['after the line append', () => { failOpening('messages.idx') }],
    ['after the idx append', () => { failOpening('meta.json.tmp') }],
    ['before the meta.json rename', failNextCommit],
  ])('keeps the last committed append readable when an append crashes %s', async (_point, crash) => {
    const { open, session } = fixture()
    const committed = rows(3)
    const revision = await write(open(), { kind: 'replace', rows: committed }, null)
    crash()
    await expect(write(open(), { kind: 'append', rows: rows(2, 3) }, revision)).rejects.toThrow(/injected crash/)
    const restarted = open()
    expect(await restarted.sessions.readDocument('chat')).toMatchObject({ messages: committed, messageCount: 3, revision })
    expect(await restarted.sessions.readMessages('chat', { start: 0, end: Infinity })).toEqual(committed)
    const next = rows(1, 9)
    await write(restarted, { kind: 'append', rows: next }, revision)
    expect(await open().sessions.readMessages('chat', { start: 0, end: Infinity })).toEqual([...committed, ...next])
    // The uncommitted tail is gone from the files themselves, so `cat` and `jq` see only committed rows.
    expect(fs.readFileSync(join(session, 'gen-1', 'messages.jsonl'), 'utf8')).toBe([...committed, ...next].map((row) => `${JSON.stringify(row)}\n`).join(''))
    expect(fs.statSync(join(session, 'gen-1', 'messages.idx')).size).toBe(4 * 8)
  })

  it('keeps the old generation authoritative when a splice crashes after writing the new one', async () => {
    const { open, session } = fixture()
    const committed = rows(4)
    const revision = await write(open(), { kind: 'replace', rows: committed }, null)
    failNextCommit()
    await expect(write(open(), { kind: 'splice', from: 1, deleteCount: 2, rows: rows(1, 20) }, revision)).rejects.toThrow(/injected crash/)
    expect(fs.readFileSync(join(session, 'gen-2', 'messages.jsonl'), 'utf8').split('\n')).toHaveLength(3 + 1)
    const restarted = open()
    expect(await restarted.sessions.readDocument('chat')).toMatchObject({ messages: committed, revision })
    await write(restarted, { kind: 'splice', from: 1, deleteCount: 2, rows: rows(1, 30) }, revision)
    expect(await open().sessions.readMessages('chat', { start: 0, end: Infinity })).toEqual([committed[0], ...rows(1, 30), committed[3]])
    expect(fs.readdirSync(session).sort()).toEqual(['backup', 'gen-2', 'meta.json'])
  })
})

describe('cost in a 5,000-row session', () => {
  /** Bytes read and written through each file, by name, counted at the file handles the backend opens. */
  function countBytes(): Map<string, { read: number; written: number }> {
    const counts = new Map<string, { read: number; written: number }>()
    vi.mocked(fsp.open).mockImplementation(async (path, ...rest) => {
      const handle = await realOpen(path, ...rest)
      const count = counts.get(basename(String(path))) ?? { read: 0, written: 0 }
      counts.set(basename(String(path)), count)
      const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<fsp.FileReadResult<Buffer>>
      const write = handle.write.bind(handle) as (...args: unknown[]) => Promise<{ bytesWritten: number }>
      return Object.assign(handle, {
        read: async (...args: unknown[]) => { const result = await read(...args); count.read += result.bytesRead; return result },
        write: async (...args: unknown[]) => { const result = await write(...args); count.written += result.bytesWritten; return result },
      })
    })
    return counts
  }
  const all = rows(5000)
  const big = async () => { const { open } = fixture(); const store = open(); return { store, revision: await write(store, { kind: 'replace', rows: all }, null) } }

  it('reads a 50-row page as those rows plus two offsets', async () => {
    const { store } = await big()
    const counts = countBytes()
    expect(await store.sessions.readMessages('chat', { start: 4000, end: 4050 })).toEqual(all.slice(4000, 4050))
    expect(Object.fromEntries(counts)).toEqual({ 'messages.idx': { read: 16, written: 0 }, 'messages.jsonl': { read: lineBytes(all.slice(4000, 4050)), written: 0 } })
  })

  it('appends by writing only the new rows and their offsets', async () => {
    const { store, revision } = await big()
    const counts = countBytes()
    const added = rows(3, 5000)
    await write(store, { kind: 'append', rows: added }, revision)
    expect(counts.get('messages.jsonl')).toEqual({ read: 0, written: lineBytes(added) })
    expect(counts.get('messages.idx')).toEqual({ read: 0, written: 3 * 8 })
    expect(await store.sessions.readMessages('chat', { start: 4999, end: Infinity })).toEqual([all[4999], ...added])
  })

  it('searches depth 5 by reading only the first five lines', async () => {
    const { store } = await big()
    const counts = countBytes()
    expect(await store.sessions.searchMessages(['chat'], sessionSearchTerms('row 4999'), 5)).toEqual(new Map())
    expect(Object.fromEntries(counts)).toEqual({ 'messages.idx': { read: 8, written: 0 }, 'messages.jsonl': { read: lineBytes(all.slice(0, 5)), written: 0 } })
    expect((await store.sessions.searchMessages(['chat'], sessionSearchTerms('row 4999'), 0)).get('chat')).toMatchObject({ idx: 4999 })
  })
})

it('restores the shrink backup over an unreadable live meta.json, as the JSON adapter restores over an unparseable file', async () => {
  const { open, session } = fixture()
  const store = open()
  const revision = await write(store, { kind: 'replace', rows: rows(3) }, null)
  await write(store, { kind: 'replace', rows: rows(1) }, revision)
  fs.writeFileSync(join(session, 'meta.json'), '{"revision":')
  const issues = await store.sessions.diagnose()
  expect(issues).toMatchObject([{ session_id: 'chat', kind: 'shrunken_live', recommendation: 'restore_from_bak', live_messages: -1, bak_messages: 3 }])
  expect(await store.sessions.repair(issues[0]!)).toBe(true)
  expect(await open().sessions.readMessages('chat', { start: 0, end: Infinity })).toEqual(rows(3))
})
