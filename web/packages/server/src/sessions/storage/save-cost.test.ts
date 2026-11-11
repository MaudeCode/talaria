import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { bootTestServer } from '../../test/harness.js'
import { sessionPath, useJsonStorage } from '../../test/storage.js'

useJsonStorage()

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

/** The document bytes the writer produced before TAL-1739: one `JSON.stringify` of the whole document. */
function legacyDocumentBytes(doc: Record<string, unknown>): string {
  const rows = doc.messages as unknown[]
  const document: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'messages') continue
    document[key] = key === 'message_count' ? rows.length : value
    if (key === 'anchor_scene_index') document.messages = rows
  }
  document.messages ??= rows
  return JSON.stringify(document)
}

it('saves a resident 1,600-message session serializing each row once, no whole document and no re-read, with unchanged bytes (TAL-1739)', async () => {
  const server = await bootTestServer()
  try {
    const store = server.deps.sessionStore
    const session = await store.newSession()
    session.owner_person_id = 'person-1'
    session.extra.custom_field = { nested: ['"quoted" \\ ] }', 'É 🙂'] }
    session.tool_calls = [{ name: 'synthetic', args: { messages: [] } }]
    session.messages = Array.from({ length: 1600 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'x'.repeat(i % 7)}`, ...(i % 5 ? {} : { meta: { messages: [i] } }) }))
    const path = sessionPath(store, session.session_id)
    const reads = vi.mocked(fs.readFileSync)
    for (const edit of ['first save', 'append'] as const) {
      if (edit === 'append') session.messages.push({ role: 'user', content: 'one more' })
      reads.mockClear()
      const stringify = vi.spyOn(JSON, 'stringify')
      await store.save(session)
      const rowSerializations = stringify.mock.calls.filter(([value]) => (value as { role?: unknown } | null)?.role)
      const documentSerializations = stringify.mock.calls.filter(([value]) => Array.isArray((value as { messages?: unknown } | null)?.messages))
      expect(rowSerializations, edit).toHaveLength(session.messages.length)
      expect(new Set(rowSerializations.map(([row]) => row as unknown)).size, edit).toBe(session.messages.length)
      expect(documentSerializations, edit).toHaveLength(0)
      expect(reads.mock.calls.filter(([file]) => file === path), edit).toHaveLength(0)
      stringify.mockRestore()
      expect(fs.readFileSync(path, 'utf8'), edit).toBe(legacyDocumentBytes(session.toDocument()))
    }
  } finally { vi.restoreAllMocks(); await server.close() }
})

it.each(['cold', 'evicted', 'externally changed', 'metadata-only'] as const)('loads a %s session with one asynchronous file read and parse', async (state) => {
  const server = await bootTestServer()
  try {
    const store = server.deps.sessionStore
    const session = await store.newSession()
    session.messages = Array.from({ length: 1000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}` }))
    await store.save(session)
    await store.index()
    const path = sessionPath(store, session.session_id)
    if (state === 'externally changed') {
      const doc = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>
      fs.writeFileSync(path, JSON.stringify({ ...doc, title: 'external title' }))
    } else {
      store.sessions.clear()
      if (state === 'evicted') {
        const cap = vi.spyOn(store.deps, 'cacheMax').mockReturnValue(1)
        await store.get(session.session_id)
        await store.newSession()
        expect(store.sessions.has(session.session_id)).toBe(false)
        cap.mockRestore()
      } else if (state === 'metadata-only') {
        expect((await store.get(session.session_id, { metadataOnly: true })).loadedMetadataOnly).toBe(true)
      }
    }
    const reads = vi.mocked(fs.readFileSync)
    const asyncReads = vi.mocked(fsp.readFile)
    reads.mockClear()
    asyncReads.mockClear()
    const parse = vi.spyOn(JSON, 'parse')
    const stringify = vi.spyOn(JSON, 'stringify')
    const loaded = await store.get(session.session_id)
    const documentParses = parse.mock.calls.filter(([text]) => text.includes(session.session_id) && text.includes('"messages"'))
    const messageSerializations = stringify.mock.calls.filter(([value]) => (value as { role?: unknown } | null)?.role)
    parse.mockRestore()
    stringify.mockRestore()
    expect(loaded.messages).toEqual(session.messages)
    expect(loaded.loadedMetadataOnly).toBe(false)
    expect.soft(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(0)
    expect.soft(asyncReads.mock.calls.filter(([file]) => file === path)).toHaveLength(1)
    expect.soft(documentParses).toHaveLength(1)
    expect.soft(messageSerializations).toHaveLength(0)
    if (state === 'externally changed') expect(loaded.title).toBe('external title')
  } finally { vi.restoreAllMocks(); await server.close() }
})

it('defers loaded message fingerprints until saving and detects nested in-place edits', async () => {
  const server = await bootTestServer()
  try {
    const store = server.deps.sessionStore
    const session = await store.newSession()
    session.messages = [{ role: 'user', content: [{ type: 'text', text: 'original' }] }, { role: 'assistant', content: 'answer' }]
    await store.save(session)
    await store.index()
    store.sessions.clear()
    const stringify = vi.spyOn(JSON, 'stringify')
    const loaded = await store.get(session.session_id)
    expect(stringify.mock.calls.filter(([value]) => (value as { role?: unknown } | null)?.role)).toHaveLength(0)
    const content = loaded.messages[0]!.content as { type: string; text: string }[]
    content[0]!.text = 'edited'
    const write = vi.spyOn(store.deps.storage.sessions, 'write')
    await store.save(loaded)
    expect(write.mock.calls[0]?.[1].messages).toEqual({ kind: 'splice', from: 0, deleteCount: 1, rows: [loaded.messages[0]] })
    expect(stringify.mock.calls.filter(([value]) => (value as { role?: unknown } | null)?.role)).toHaveLength(4)
    stringify.mockClear()
    await store.save(loaded)
    expect(write.mock.calls[1]?.[1].messages).toEqual({ kind: 'unchanged' })
    expect(stringify.mock.calls.filter(([value]) => (value as { role?: unknown } | null)?.role)).toHaveLength(2)
    stringify.mockRestore()
    expect(await store.readMessages(session.session_id, { start: 0, end: Infinity })).toEqual(loaded.messages)
  } finally { vi.restoreAllMocks(); await server.close() }
})

it('retries a load if an atomic replacement changes the revision after reading', async () => {
  const server = await bootTestServer()
  try {
    const store = server.deps.sessionStore
    const session = await store.newSession()
    session.messages = [{ role: 'user', content: 'original' }]
    await store.save(session)
    await store.index()
    store.sessions.clear()
    const path = sessionPath(store, session.session_id)
    const doc = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>
    const messages = [{ role: 'user', content: 'replacement' }, { role: 'assistant', content: 'new answer' }]
    fs.writeFileSync(`${path}.replacement`, JSON.stringify({ ...doc, title: 'replacement', messages, message_count: messages.length }))
    const revision = store.deps.storage.sessions.revision.bind(store.deps.storage.sessions)
    vi.spyOn(store.deps.storage.sessions, 'revision').mockImplementationOnce(async (sid) => {
      fs.renameSync(`${path}.replacement`, path)
      return revision(sid)
    })
    const reads = vi.mocked(fsp.readFile)
    reads.mockClear()
    const loaded = await store.get(session.session_id)
    expect(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(2)
    expect(loaded.title).toBe('replacement')
    expect(loaded.messages).toEqual(messages)
    expect(loaded.sidecarLoadedSignature).toBe(await store.revision(session.session_id))
  } finally { vi.restoreAllMocks(); await server.close() }
})
