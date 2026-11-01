import { useJsonStorage } from '../../test/storage.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { bootTestServer } from '../../test/harness.js'
import { FakeSidecar } from '../../sidecar/fake.js'

useJsonStorage()

it('batches session saves that commit during an index flush into one follow-up flush', async () => {
  const server = await bootTestServer()
  try {
    const store = server.deps.sessionStore
    const first = await store.newSession()
    const second = await store.newSession()
    const third = await store.newSession()
    await store.writeIndex()
    const sessions = store.deps.storage.sessions
    const persist = sessions.writeIndex.bind(sessions)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const writeIndex = vi.spyOn(sessions, 'writeIndex').mockImplementationOnce(async (entries) => { await held; await persist(entries) })
    for (const session of [first, second, third]) session.messages = [{ role: 'user', content: session.session_id }]
    await store.save(first)
    await Promise.all([store.save(second), store.save(third)])
    release()
    await store.queueIndexUpdate([])
    expect(writeIndex).toHaveBeenCalledTimes(2)
    const rows = await store.readIndexEntries()
    expect(rows.filter((row) => row.message_count === 1).map((row) => row.session_id).sort()).toEqual([first.session_id, second.session_id, third.session_id].sort())
    await store.delete(third.session_id)
    first.messages.push({ role: 'assistant', content: 'first answer' })
    second.messages.push({ role: 'assistant', content: 'second answer' })
    writeIndex.mockRejectedValueOnce(new Error('synthetic index failure'))
    // The session files are committed; a failed index batch neither fails the saves nor drops their rows.
    await Promise.all([store.save(first), store.save(second)])
    // An index read retries the queued rows instead of serving the stale file.
    expect((await store.readIndexEntries()).map((row) => row.message_count)).toEqual([2, 2])
    expect((await store.readIndexEntries()).map((row) => row.message_count)).toEqual([2, 2])
    // While the retry keeps failing, readers see an unreadable index, never a stale one.
    second.messages.push({ role: 'user', content: 'again' })
    writeIndex.mockRejectedValueOnce(new Error('synthetic index failure')).mockRejectedValueOnce(new Error('synthetic index failure'))
    await store.save(second)
    await expect(store.readIndexEntries()).rejects.toThrow('synthetic index failure')
    first.messages.push({ role: 'user', content: 'again' })
    writeIndex.mockRejectedValueOnce(new Error('synthetic index failure'))
    await store.save(first)
    await store.delete(first.session_id)
    expect((await store.readIndexEntries()).map((row) => [row.session_id, row.message_count])).toEqual([[second.session_id, 3]])
  } finally { vi.restoreAllMocks(); await server.close() }
})

it('diagnoses only after in-flight index publication and preserves corrupt raw index evidence', async () => {
  const server = await bootTestServer()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  try {
    const store = server.deps.sessionStore
    const first = await store.newSession()
    first.messages = [{ role: 'user', content: 'first retained session' }]
    await store.save(first)
    await store.readIndexEntries()
    const backend = store.deps.storage.sessions
    const persist = backend.writeIndex.bind(backend)
    vi.spyOn(backend, 'writeIndex').mockImplementationOnce(async (entries) => { entered(); await held; await persist(entries) })
    const session = await store.newSession()
    session.messages = [{ role: 'user', content: 'new retained session' }]
    await store.save(session)
    await started
    let settled = false
    const diagnosis = store.diagnose().then((issues) => { settled = true; return issues })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled, 'diagnosis must wait for the held index publication').toBe(false)
    release()
    expect((await diagnosis).filter((issue) => issue.session_id === session.session_id)).toEqual([])
    const index = join(server.state, 'sessions', '_index.json')
    writeFileSync(index, '{corrupt index')
    const before = readFileSync(index, 'utf8')
    expect((await store.diagnose()).some((issue) => issue.kind === 'index_unreadable')).toBe(true)
    expect(readFileSync(index, 'utf8')).toBe(before)
  } finally { release(); vi.restoreAllMocks(); await server.close() }
})

it('admits only one turn while persistence outlasts the stale-state grace period', async () => {
  let now = 1000
  let releaseWrite!: () => void
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
  let enteredWrite!: () => void
  const writeStarted = new Promise<void>((resolve) => { enteredWrite = resolve })
  let releaseWorker!: () => void
  const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve })
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', async () => { await workerGate; throw new Error('test worker finished') })
  const server = await bootTestServer({ sidecar, now: () => now })
  try {
    const store = server.deps.sessionStore
    const session = await store.newSession()
    const write = store.deps.storage.sessions.write.bind(store.deps.storage.sessions)
    vi.spyOn(store.deps.storage.sessions, 'write').mockImplementationOnce(async (...args) => {
      enteredWrite()
      await writeGate
      return write(...args)
    })
    const options = { msg: 'first', workspace: server.state, model: null, modelProvider: null }
    const first = server.deps.turns.start(session, options)
    await writeStarted
    expect(server.deps.registry.activeRunStreamForSession(session.session_id)).toBeTruthy()
    expect(server.deps.registry.attachableRunForSession(session.session_id)).toBeNull()
    now += 31
    const second = server.deps.turns.start(session, { ...options, msg: 'second' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseWrite()
    const results = await Promise.all([first, second])
    releaseWorker()
    for (const result of results) if (result.stream_id) await server.deps.turns.finished(result.stream_id)
    expect(results.filter((result) => result._status === undefined)).toHaveLength(1)
    expect(results.find((result) => result._status === 409)?.error).toBe('session already has an active stream')
  } finally { releaseWrite(); releaseWorker(); vi.restoreAllMocks(); await server.close() }
})

it('releases the admission reservation if the pending snapshot cannot be persisted', async () => {
  const server = await bootTestServer()
  try {
    const session = await server.deps.sessionStore.newSession()
    vi.spyOn(server.deps.sessionStore.deps.storage.sessions, 'write').mockRejectedValueOnce(new Error('synthetic disk-full'))
    await expect(server.deps.turns.start(session, { msg: 'first', workspace: server.state, model: null, modelProvider: null })).rejects.toThrow('synthetic disk-full')
    expect(server.deps.registry.activeRunStreamForSession(session.session_id)).toBeNull()
    expect(server.deps.registry.attachableRunForSession(session.session_id)).toBeNull()
  } finally { vi.restoreAllMocks(); await server.close() }
})

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
    store.deps.storage = { ...original, close: async () => { await original.close(); }, sessions: new Proxy(original.sessions, {
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
