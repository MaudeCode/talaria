import * as fs from 'node:fs'
import { expect, it, vi } from 'vitest'
import { bootTestServer } from '../../test/harness.js'
import { sessionPath } from '../../test/storage.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

it('saves a resident 1,000-message session with one document serialization and no re-read', async () => {
  const server = await bootTestServer()
  try {
    const store = server.deps.sessionStore
    const session = await store.newSession()
    session.messages = Array.from({ length: 1000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}` }))
    await store.save(session)
    session.messages.push({ role: 'user', content: 'one more' })
    const path = sessionPath(store, session.session_id)
    const reads = vi.mocked(fs.readFileSync)
    reads.mockClear()
    const stringify = vi.spyOn(JSON, 'stringify')
    await store.save(session)
    const documentWrites = stringify.mock.calls.filter(([value]) => (value as { session_id?: unknown } | null)?.session_id === session.session_id && Array.isArray((value as { messages?: unknown }).messages))
    stringify.mockRestore()
    expect(documentWrites).toHaveLength(1)
    expect(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(0)
    const stored = JSON.parse(fs.readFileSync(path, 'utf8')) as { messages: unknown[]; message_count: number }
    expect(stored.messages).toHaveLength(1001)
    expect(stored.message_count).toBe(1001)
  } finally { vi.restoreAllMocks(); await server.close() }
})
