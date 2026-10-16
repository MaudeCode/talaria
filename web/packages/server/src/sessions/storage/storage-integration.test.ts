import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { bootTestServer } from '../../test/harness.js'

it('skips malformed documents without assigning a generated session identity', async () => {
  const server = await bootTestServer()
  try {
    for (const value of [null, [], 42, { session_id: 'wrong-id', messages: [] }]) {
      writeFileSync(join(server.state, 'sessions', 'invalid.json'), JSON.stringify(value))
      await expect(server.deps.sessionStore.load('invalid')).resolves.toBeNull()
    }
  } finally { await server.close() }
})

it('batches content search after title matching without loading each candidate through get', async () => {
  const server = await bootTestServer()
  try {
    const store = server.deps.sessionStore
    const ids: string[] = []
    for (const title of ['needle title', 'First content', 'Second content']) {
      const session = await store.newSession()
      session.title = title
      session.messages = [{ role: 'user', content: 'needle in content' }]
      await store.save(session)
      ids.push(session.session_id)
    }
    store.sessions.clear()
    const get = vi.spyOn(store, 'get')
    const search = vi.spyOn(store.deps.storage.sessions, 'searchMessages')
    const response = await server.deps.sessions.search('needle', { content: true, depth: 5, allProfiles: true })
    expect(search).toHaveBeenCalledTimes(1)
    expect(new Set(search.mock.calls[0]![0])).toEqual(new Set(ids.slice(1)))
    expect(get).not.toHaveBeenCalled()
    expect((response.sessions as Record<string, unknown>[]).find((r) => r.session_id === ids[0])?.match_type).toBe('title')
    expect((response.sessions as Record<string, unknown>[]).filter((r) => r.match_type === 'content')).toHaveLength(2)
  } finally { vi.restoreAllMocks(); await server.close() }
})

it('shares one resident session across concurrent cold reads with asynchronous storage', async () => {
  const server = await bootTestServer()
  try {
    const store = server.deps.sessionStore
    const session = await store.newSession()
    session.messages = [{ role: 'user', content: 'saved' }]
    await store.save(session)
    store.sessions.clear()
    const original = store.deps.storage
    store.deps.storage = { ...original, close: () => original.close(), sessions: new Proxy(original.sessions, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver)
        if (typeof value !== 'function') return value
        return async (...args: unknown[]): Promise<unknown> => {
          await new Promise<void>((resolve) => setImmediate(resolve))
          return Reflect.apply(value, target, args)
        }
      },
    }) }
    const [first, second] = await Promise.all([store.get(session.session_id), store.get(session.session_id)])
    expect(first, 'concurrent callers must share the cache owner').toBe(second)
  } finally { await server.close() }
})

it('rejects a stale save and reloads the externally committed transcript', async () => {
  const server = await bootTestServer()
  try {
    const store = server.deps.sessionStore
    const session = (await store.newSession())
    session.messages = [{ role: 'user', content: 'original' }]
    await store.save(session)
    const path = join(server.state, 'sessions', `${session.session_id}.json`)
    const external = (JSON.parse(readFileSync(path, 'utf8')) as { messages: Record<string, unknown>[]; message_count: number })
    external.messages.push({ role: 'assistant', content: 'externally committed' })
    external.message_count = 2
    writeFileSync(path, JSON.stringify(external, null, 2))
    session.title = 'stale edit'
    let conflict: unknown
    try { await store.save(session) } catch (error) { conflict = error }
    expect(conflict, 'a stale save must reject instead of overwriting committed messages').toMatchObject({ name: 'RevisionConflict' })
    expect((await store.get(session.session_id)).messages).toEqual(external.messages)
    expect((JSON.parse(readFileSync(path, 'utf8')) as { messages: Record<string, unknown>[]; message_count: number }).messages).toEqual(external.messages)
  } finally { await server.close() }
})
