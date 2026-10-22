import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fsp from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { JsonStorage } from './json.js'
import { readJsonMessagePrefix, statSignature } from './json-files.js'
import { runSessionBackendConformance } from './conformance.js'

vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, renameSync: vi.fn(real.renameSync), readFileSync: vi.fn(real.readFileSync), readdirSync: vi.fn(real.readdirSync) }
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
