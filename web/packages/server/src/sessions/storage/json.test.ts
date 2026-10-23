import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fsp from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { RevisionConflict, type SessionChange } from './backend.js'
import { JsonStorage } from './json.js'
import type { Message } from '../session.js'
import { gateFsync, onNextOpen } from '../../test/fs-handles.js'
import { readJsonMessagePrefix, statSignature } from './json-files.js'
import { runSessionBackendConformance } from './conformance.js'

vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, renameSync: vi.fn(real.renameSync), readFileSync: vi.fn(real.readFileSync), readdirSync: vi.fn(real.readdirSync), writeSync: vi.fn(real.writeSync), fsyncSync: vi.fn(real.fsyncSync) }
})
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof fsp>()
  return { ...real, open: vi.fn(real.open), readFile: vi.fn(real.readFile) }
})

runSessionBackendConformance('JSON', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'talaria-json-conformance-'))
  return {
    storage: new JsonStorage({ directory, now: () => Date.now() / 1000, stampingSince: () => 0 }),
    failNextWrite: () => { vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('injected publication failure') }) },
    cleanup: () => { fs.rmSync(directory, { recursive: true, force: true }) },
  }
})

it('keeps persisted ids current across owned writes, deletes, external edits and caller mutations (TAL-1226)', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'talaria-json-ids-'))
  const storage = new JsonStorage({ directory, now: () => Date.now() / 1000, stampingSince: () => 0 })
  const write = (sid: string) => storage.sessions.write(sid, { doc: { session_id: sid }, messages: { kind: 'replace', rows: [] } }, null)
  const scans = vi.mocked(fs.readdirSync)
  try {
    scans.mockClear()
    expect(await storage.sessions.ids()).toEqual(new Set())
    await write('first')
    expect(await storage.sessions.ids()).toEqual(new Set(['first']))
    const returned = await storage.sessions.ids()
    returned.clear()
    returned.add('invented')
    expect(await storage.sessions.ids()).toEqual(new Set(['first']))
    await storage.sessions.delete('first', { tombstone: true })
    expect(await storage.sessions.ids()).toEqual(new Set())
    // Initial read plus revalidation after each owned mutation; unchanged reads reuse the set.
    expect(scans).toHaveBeenCalledTimes(3)

    fs.writeFileSync(join(directory, 'external.json'), '{}')
    fs.utimesSync(directory, 2000000000, 2000000000)
    // An owned write must not mask an external entry created since the last read.
    await write('second')
    expect(await storage.sessions.ids()).toEqual(new Set(['external', 'second']))
    fs.unlinkSync(join(directory, 'external.json'))
    fs.utimesSync(directory, 2100000000, 2100000000)
    await storage.sessions.delete('second', { tombstone: false })
    expect(await storage.sessions.ids()).toEqual(new Set())
  } finally { vi.restoreAllMocks(); await storage.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

it('drops cached persisted ids when the directory disappears and preserves strict read errors (TAL-1226)', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'talaria-json-ids-errors-'))
  const storage = new JsonStorage({ directory, now: () => Date.now() / 1000, stampingSince: () => 0 })
  try {
    fs.writeFileSync(join(directory, 'first.json'), '{}')
    expect(await storage.sessions.ids()).toEqual(new Set(['first']))
    fs.rmSync(directory, { recursive: true })
    expect(await storage.sessions.ids({ strict: true })).toEqual(new Set())
    fs.mkdirSync(directory)
    fs.writeFileSync(join(directory, 'second.json'), '{}')
    const denied = Object.assign(new Error('synthetic denied directory'), { code: 'EACCES' })
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => { throw denied })
    await expect(storage.sessions.ids({ strict: true })).rejects.toBe(denied)
    expect(await storage.sessions.ids()).toEqual(new Set(['second']))
  } finally { vi.restoreAllMocks(); await storage.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

it.each([['write', 'add'], ['write', 'remove'], ['delete', 'add'], ['delete', 'remove']] as const)('sees external changes interleaved with an owned %s (%s, TAL-1226)', async (operation, external) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'talaria-json-ids-race-'))
  const storage = new JsonStorage({ directory, now: () => Date.now() / 1000, stampingSince: () => 0 })
  const change = { doc: { session_id: 'owned' }, messages: { kind: 'replace' as const, rows: [] } }
  try {
    const revision = await storage.sessions.write('owned', change, await storage.sessions.revision('owned'))
    const externalPath = join(directory, 'external.json')
    if (external === 'remove') fs.writeFileSync(externalPath, '{}')
    else fs.rmSync(externalPath, { force: true })
    expect(await storage.sessions.ids()).toEqual(new Set(external === 'remove' ? ['owned', 'external'] : ['owned']))
    const mutate = (): void => {
      if (external === 'add') fs.writeFileSync(externalPath, '{}')
      else fs.unlinkSync(externalPath)
      fs.utimesSync(directory, 2000000000, 2000000000)
    }
    if (operation === 'write') {
      const rename = vi.mocked(fs.renameSync).getMockImplementation()!
      vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => { rename(from, to); mutate() })
      await storage.sessions.write('owned', change, revision)
    } else {
      const remove = fs.rmSync
      const spy = vi.spyOn(fs, 'rmSync').mockImplementationOnce((path, options) => { remove(path, options); mutate() })
      await storage.sessions.delete('owned', { tombstone: false })
      spy.mockRestore()
    }
    const expected = new Set([...(operation === 'write' ? ['owned'] : []), ...(external === 'add' ? ['external'] : [])])
    expect.soft(await storage.sessions.ids()).toEqual(expected)
    expect.soft(await storage.sessions.ids()).toEqual(expected)
  } finally { vi.restoreAllMocks(); await storage.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

it('content search parses at most depth messages per file and a repeated search reads no files (TAL-1212)', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'talaria-json-search-'))
  const storage = new JsonStorage({ directory, now: () => Date.now() / 1000, stampingSince: () => 0 })
  try {
    const sids = Array.from({ length: 50 }, (_, n) => `s${n}`)
    for (const [n, sid] of sids.entries()) {
      const rows = Array.from({ length: 2000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i === (n % 2 ? 3 : 1500) ? `needle ${sid}` : `filler ${i}` }))
      await storage.sessions.write(sid, { doc: { session_id: sid, title: sid, updated_at: 1, anchor_scene_index: [] }, messages: { kind: 'replace', rows } }, null)
    }
    const expected = new Map(sids.filter((_, n) => n % 2).map((sid) => [sid, { idx: 3, text: `needle ${sid}` }]))
    const parse = vi.spyOn(JSON, 'parse')
    expect(await storage.sessions.searchMessages(sids, ['needle'], 5)).toEqual(expected)
    const parsedRows = parse.mock.results.reduce((sum, r) => sum + (Array.isArray((r.value as { messages?: unknown } | null)?.messages) ? (r.value as { messages: unknown[] }).messages.length : 1), 0)
    expect(parsedRows).toBeLessThanOrEqual(sids.length * 5)
    parse.mockClear()
    const reads = [vi.mocked(fs.readFileSync), vi.mocked(fsp.open), vi.mocked(fsp.readFile)]
    for (const read of reads) read.mockClear()
    expect(await storage.sessions.searchMessages(sids, ['needle'], 5)).toEqual(expected)
    expect(parse).not.toHaveBeenCalled()
    for (const read of reads) expect(read).not.toHaveBeenCalled()
    for (const depth of [0, 21, Infinity]) {
      await storage.sessions.searchMessages(sids.slice(0, 1), ['needle'], depth)
      vi.mocked(fsp.open).mockClear()
      await storage.sessions.searchMessages(sids.slice(0, 1), ['needle'], depth)
      expect(fsp.open, `depth ${depth} is not kept resident`).toHaveBeenCalledTimes(1)
    }
  } finally {
    vi.restoreAllMocks()
    await storage.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it('reads a message prefix equal to the full parse across chunk boundaries and falls back for unscannable documents', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'talaria-json-prefix-'))
  const file = (name: string, text: string) => { const path = join(directory, name); fs.writeFileSync(path, text); return path }
  try {
    const rows = [
      { role: 'user', content: 'Straße "quoted" \\ ] } { [ ÉCHO 🙂' },
      { role: 'assistant', content: [{ type: 'text', text: 'nested [1, {"a": 2}]' }], extra: { messages: [{ fake: true }] } },
      {}, { role: 'user', content: '' },
    ]
    const doc = { session_id: 's', title: 'messages', note: { messages: 'not here' }, list: ['messages', { x: '}' }], messages: rows, after: '{' }
    for (const text of [JSON.stringify(doc), JSON.stringify(doc, null, 2)]) {
      const path = file('doc.json', text)
      for (const chunk of [1, 3, 7, 64 * 1024]) for (const limit of [1, 2, 3, 4, 9, Infinity]) {
        expect((await readJsonMessagePrefix(path, limit, chunk)).rows, `${chunk}/${limit}`).toEqual(rows.slice(0, limit))
      }
    }
    expect((await readJsonMessagePrefix(file('empty.json', '{"messages": []}'), 5, 2)).rows).toEqual([])
    expect((await readJsonMessagePrefix(file('none.json', '{"title": "x"}'), 5, 2)).rows).toEqual([])
    expect((await readJsonMessagePrefix(file('null.json', '{"messages": null}'), 5, 2)).rows).toEqual([])
    expect((await readJsonMessagePrefix(file('mixed.json', '{"messages": [{"a": 1}, 2, {"b": 3}]}'), 5, 2)).rows).toEqual([{ a: 1 }, 2, { b: 3 }])
    await expect(readJsonMessagePrefix(file('cut.json', '{"messages": [{"a": 1}, {"b'), 5, 2)).rejects.toThrow(SyntaxError)
    const signed = file('signed.json', '{"messages": [{"a": 1}]}')
    expect((await readJsonMessagePrefix(signed, 1)).signature).toBe(statSignature(signed))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `row ${i}` }))
const replace = (sid: string, rows: Message[], title = 'Test'): SessionChange => ({ doc: { session_id: sid, title }, messages: { kind: 'replace', rows } })
async function withStorage(run: (storage: JsonStorage, directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'talaria-json-async-'))
  const storage = new JsonStorage({ directory, now: () => Date.now() / 1000, stampingSince: () => 0 })
  try { await run(storage, directory) } finally { vi.restoreAllMocks(); await storage.close(); fs.rmSync(directory, { recursive: true, force: true }) }
}
const stored = (directory: string, sid = 's') => JSON.parse(fs.readFileSync(join(directory, `${sid}.json`), 'utf8')) as { title: string; messages: unknown[] }

it('stages a session write and its fsync off the event loop, then publishes the shrink backup and document together (TAL-1304)', async () => {
  await withStorage(async (storage, directory) => {
    const path = join(directory, 's.json')
    const revision = await storage.sessions.write('s', replace('s', rowsOf(3)), null)
    const previous = fs.readFileSync(path, 'utf8')
    vi.mocked(fs.writeSync).mockClear()
    vi.mocked(fs.fsyncSync).mockClear()
    const gate = gateFsync((file) => file.startsWith(`${path}.tmp.`))
    const order: string[] = []
    let result: string | undefined
    const pending = storage.sessions.write('s', replace('s', rowsOf(1), 'shrunk'), revision).then((rev) => { result = rev; order.push('saved') })
    void setImmediate().then(() => order.push('tick'))
    await Promise.race([gate.started, pending])
    await setImmediate()
    expect(order).toEqual(['tick'])
    expect(fs.writeSync).not.toHaveBeenCalled()
    expect(fs.fsyncSync).not.toHaveBeenCalled()
    expect(fs.readFileSync(path, 'utf8')).toBe(previous)
    expect(fs.existsSync(`${path}.bak`)).toBe(false)
    expect(await storage.sessions.revision('s')).toBe(revision)
    gate.release()
    await pending
    expect(order).toEqual(['tick', 'saved'])
    expect(result).toBe(await storage.sessions.revision('s'))
    expect(stored(directory)).toMatchObject({ title: 'shrunk', messages: rowsOf(1) })
    expect(fs.readFileSync(`${path}.bak`, 'utf8')).toBe(previous)
    expect(fs.readdirSync(directory).sort()).toEqual(['s.json', 's.json.bak'])
  })
})

it('refuses to publish over a replacement made while the write was staging (TAL-1304)', async () => {
  await withStorage(async (storage, directory) => {
    const path = join(directory, 's.json')
    const revision = await storage.sessions.write('s', replace('s', rowsOf(2)), null)
    const gate = gateFsync((file) => file.startsWith(`${path}.tmp.`))
    const pending = storage.sessions.write('s', replace('s', rowsOf(1), 'stale'), revision)
    const refused = expect(pending).rejects.toBeInstanceOf(RevisionConflict)
    await gate.started
    fs.writeFileSync(path, JSON.stringify({ session_id: 's', title: 'external', messages: [] }))
    gate.release()
    await refused
    expect(stored(directory).title).toBe('external')
    expect(fs.readdirSync(directory)).toEqual(['s.json'])
  })
})

it.each([
  ['a short write', (handle: fsp.FileHandle) => { vi.spyOn(handle, 'write').mockImplementationOnce(() => Promise.resolve({ bytesWritten: 0, buffer: '' })) }],
  ['a write error', (handle: fsp.FileHandle) => { vi.spyOn(handle, 'write').mockRejectedValueOnce(new Error('injected write failure')) }],
  ['an fsync error', (handle: fsp.FileHandle) => { vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('injected fsync failure')) }],
  ['a rename error', null],
] as const)('keeps the previous document and leaves no staged file or open handle after %s (TAL-1304)', async (_, inject) => {
  await withStorage(async (storage, directory) => {
    const path = join(directory, 's.json')
    const revision = await storage.sessions.write('s', replace('s', rowsOf(3)), null)
    const previous = fs.readFileSync(path, 'utf8')
    const closed: boolean[] = []
    onNextOpen((handle) => {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { closed.push(true); await close() })
      inject?.(handle)
    }, (file) => file.startsWith(`${path}.tmp.`))
    const rename = vi.mocked(fs.renameSync).getMockImplementation()!
    if (!inject) vi.mocked(fs.renameSync).mockImplementation((from, to) => { if (to === path) throw new Error('injected rename failure'); rename(from, to) })
    await expect(storage.sessions.write('s', replace('s', rowsOf(1)), revision)).rejects.toThrow(/short write|injected/)
    vi.mocked(fs.renameSync).mockImplementation(rename)
    expect(closed.length).toBeGreaterThan(0)
    expect(fs.readFileSync(path, 'utf8')).toBe(previous)
    expect(await storage.sessions.revision('s')).toBe(revision)
    expect(fs.readdirSync(directory).filter((name) => name.includes('.tmp.'))).toEqual([])
    // A published backup only ever holds the still-live previous document.
    if (fs.existsSync(`${path}.bak`)) expect(fs.readFileSync(`${path}.bak`, 'utf8')).toBe(previous)
  })
})

it('still publishes the document when its best-effort shrink backup cannot be staged (TAL-1304)', async () => {
  await withStorage(async (storage, directory) => {
    const path = join(directory, 's.json')
    const revision = await storage.sessions.write('s', replace('s', rowsOf(3)), null)
    onNextOpen((handle) => { vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('injected backup failure')) }, (file) => file.startsWith(`${path}.bak.tmp.`))
    expect(await storage.sessions.write('s', replace('s', rowsOf(1)), revision)).toBe(await storage.sessions.revision('s'))
    expect(stored(directory).messages).toEqual(rowsOf(1))
    expect(fs.readdirSync(directory)).toEqual(['s.json'])
  })
})

it('drains a staged session write before close completes (TAL-1304)', async () => {
  await withStorage(async (storage, directory) => {
    const gate = gateFsync()
    const pending = storage.sessions.write('s', replace('s', rowsOf(2), 'drained'), null)
    await gate.started
    let closed = false
    const closing = storage.close().then(() => { closed = true })
    await setImmediate()
    expect(closed).toBe(false)
    gate.release()
    await pending
    await closing
    await expect(storage.sessions.revision('s')).rejects.toThrow(/closed/i)
    expect(stored(directory)).toMatchObject({ title: 'drained', messages: rowsOf(2) })
    expect(fs.readdirSync(directory)).toEqual(['s.json'])
  })
})
