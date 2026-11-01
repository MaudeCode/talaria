/** Memory-only tests of the real service, share store, lifecycle lock and CAS saves. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionService, type SessionServiceDeps } from './service.js'
import { SessionStore } from './store.js'
import { Session } from './session.js'
import { ShareStore } from './shares.js'
import { RevisionConflict, type DocumentBackend, type StoredDocument, type StoredSession, type StorageBackend, type SessionBackend } from './storage/backend.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const records = new Map<string, StoredDocument>()
  const sessions = new Map<string, StoredSession>()
  const tombstones = new Set<string>()
  let revision = 0
  let now = 100
  const documents = {
    get: vi.fn<DocumentBackend['get']>((_namespace, key) => Promise.resolve(structuredClone(records.get(key) ?? null))),
    put: vi.fn<DocumentBackend['put']>((_namespace, key, value, expected) => {
      if ((records.get(key)?.revision ?? null) !== expected) throw new RevisionConflict(key)
      const rev = String(++revision)
      records.set(key, { value: structuredClone(value), revision: rev })
      return Promise.resolve(rev)
    }),
    delete: vi.fn<DocumentBackend['delete']>((_namespace, key) => Promise.resolve(records.delete(key))),
    list: () => Promise.resolve([...records].map(([key, row]) => ({ key, revision: row.revision }))),
  } satisfies DocumentBackend
  const backend = {
    exists: (sid) => Promise.resolve(sessions.has(sid)),
    revision: (sid) => Promise.resolve(sessions.get(sid)?.revision ?? null),
    readDocument: (sid) => Promise.resolve(structuredClone(sessions.get(sid) ?? null)),
    ids: () => Promise.resolve(new Set(sessions.keys())),
    write: vi.fn<SessionBackend['write']>((sid, change, expected) => {
      if ((sessions.get(sid)?.revision ?? null) !== expected) throw new RevisionConflict(sid)
      const rev = String(++revision)
      const messages = structuredClone(change.all ?? [])
      sessions.set(sid, { doc: structuredClone(change.doc), messages, revision: rev, metadataOnly: false, messageCount: messages.length })
      return Promise.resolve(rev)
    }),
    delete: (sid) => { tombstones.add(sid); sessions.delete(sid); return Promise.resolve(true) },
    tombstones: {
      has: (sid) => Promise.resolve(tombstones.has(sid)),
      add: (sid) => { tombstones.add(sid); return Promise.resolve() },
      remove: (sid) => { tombstones.delete(sid); return Promise.resolve() },
      all: () => Promise.resolve(new Set(tombstones)),
    },
  } satisfies Partial<SessionBackend>
  const store = new SessionStore({
    storage: { sessions: backend } as unknown as StorageBackend,
    defaults: () => ({ workspace: '', model: null, modelProvider: null }),
    drafts: { read: () => Promise.resolve({}), delete: () => Promise.resolve(), ids: () => Promise.resolve([]) } as unknown as SessionServiceDeps['drafts'],
    events: { publish: vi.fn() } as unknown as SessionServiceDeps['events'],
    activeStreamIds: () => new Set(), now: () => now, log: () => undefined, cacheMax: () => 100,
  })
  // The sidebar index and wire projection are outside this persistence/lifecycle boundary.
  vi.spyOn(store, 'queueIndexUpdate').mockResolvedValue()
  vi.spyOn(store, 'pruneFromIndex').mockResolvedValue()
  vi.spyOn(store, 'readIndexEntries').mockResolvedValue([])
  vi.spyOn(store, 'writeIndex').mockResolvedValue()
  const shares = new ShareStore(documents, () => now)
  const service = new SessionService({
    store, shares, now: () => now, home: '/synthetic', hermesHome: '/synthetic/agent',
    profileHome: () => '/synthetic/agent', attachmentDir: () => '', activeProfile: () => 'default', isolatedProfileMode: () => false,
    profilesMatch: (a: string | null | undefined, b: string | null | undefined) => (a || 'default') === (b || 'default'), events: store.deps.events,
    runtime: { activeRunStream: () => null, activeStreamIds: new Set(), evictAgent: () => Promise.resolve(), closeTerminal: () => undefined },
  } as unknown as SessionServiceDeps)
  vi.spyOn(service, 'resolveSessionId').mockImplementation((sid) => Promise.resolve(sid === 'alias' ? 'session' : sid))
  vi.spyOn(service, 'publicSession').mockImplementation((s) => Promise.resolve(s.toDocument()))
  // Agent ownership and finalization are boundaries; deletion itself stays real.
  const boundary = service as unknown as {
    rejectViewOnly: (sid: string) => Promise<string>
    isOrphanedImport: () => Promise<boolean>
    isReadOnlyImport: () => Promise<boolean>
    isSubagentViewOnly: () => Promise<boolean>
    isMessagingSession: () => Promise<boolean>
    finalizeSession: () => Promise<void>
  }
  vi.spyOn(boundary, 'rejectViewOnly').mockImplementation((sid) => Promise.resolve(sid))
  vi.spyOn(boundary, 'isOrphanedImport').mockResolvedValue(false)
  vi.spyOn(boundary, 'isReadOnlyImport').mockResolvedValue(false)
  vi.spyOn(boundary, 'isSubagentViewOnly').mockResolvedValue(false)
  vi.spyOn(boundary, 'isMessagingSession').mockResolvedValue(true)
  vi.spyOn(boundary, 'finalizeSession').mockResolvedValue()
  const writable = vi.spyOn(service, 'assertWritable').mockResolvedValue()
  vi.spyOn(service, 'isReadOnly').mockResolvedValue(false)
  vi.spyOn(service, 'claimOrSynthesizeCliSession').mockResolvedValue({ session: null, reason: 'no_foreign_state' })
  const session = new Session({ session_id: 'session', profile: 'default', messages: [{ role: 'user', content: 'synthetic example' }] }, { workspace: '', model: null, modelProvider: null })
  await store.save(session)
  await store.touch(session)
  onTestFinished(() => { vi.restoreAllMocks() })
  const readable = async () => (await Promise.all([...records.keys()].map((key) => shares.load(key)))).filter(Boolean)
  return { service, store, shares, writable, documents, backend, records, sessions, session, readable, tick: () => { now += 1 } }
}

/** Admit operation two while the first document read is held, with or without lifecycle locking. */
async function overlap(f: Awaited<ReturnType<typeof fixture>>, second: () => Promise<unknown>) {
  const entered = deferred(), release = deferred(), queued = deferred()
  const get = f.documents.get.getMockImplementation() as DocumentBackend['get']
  let reads = 0
  vi.mocked(f.documents.get).mockImplementation(async (...args) => {
    reads += 1
    if (reads === 1) { entered.resolve(); await release.promise }
    else queued.resolve()
    return get(...args)
  })
  const withLock = f.store.withLock.bind(f.store)
  let locks = 0
  vi.spyOn(f.store, 'withLock').mockImplementation((...args) => {
    locks += 1
    if (locks === 2) queued.resolve()
    return withLock(...args)
  })
  const first = f.service.createShare('session')
  await entered.promise
  const next = second()
  try { await Promise.race([queued.promise, next]) } finally { release.resolve() }
  return Promise.all([first, next])
}

describe('share lifecycle', () => {
  it('converges overlapping first creates on one token and revokes every readable snapshot', async () => {
    const f = await fixture()
    const results = await overlap(f, () => f.service.createShare('session'))
    expect(results).toHaveLength(2)
    expect.soft(f.records.size).toBe(1)
    await f.service.revokeShare('session')
    expect(await f.readable()).toHaveLength(0)
    expect((await f.store.load('session'))?.share_token).toBeNull()
  })

  it('refreshes one token and snapshot while preserving read-only sharing eligibility and sanitization', async () => {
    const f = await fixture()
    f.session.read_only = true
    f.session.messages = [{ role: 'assistant', content: '<think>private reasoning</think>safe reply' }]
    await f.store.save(f.session)
    await f.service.createShare('session')
    const token = f.session.share_token!
    const created = f.session.share_created_at
    expect(await f.shares.load(token)).toMatchObject({ messages: [{ content: 'safe reply' }] })
    f.tick()
    f.session.messages = [{ role: 'user', content: 'updated example' }]
    await f.store.save(f.session)
    await f.service.createShare('session')
    expect(f.records.size).toBe(1)
    expect(f.session.share_token).toBe(token)
    expect(f.session.share_created_at).toBe(created)
    expect(await f.shares.load(token)).toMatchObject({ messages: [{ content: 'updated example' }], updated_at: 101 })
    expect(f.writable).not.toHaveBeenCalled()
    await f.service.revokeShare('session')
    expect(await f.readable()).toHaveLength(0)
  })

  it.each(['revoke', 'delete'] as const)('orders an overlapping create before %s without an orphan', async (action) => {
    const f = await fixture()
    await overlap(f, () => action === 'revoke' ? f.service.revokeShare('session') : f.service.delete('session'))
    expect(await f.readable()).toHaveLength(0)
    expect((await f.store.load('session'))?.share_token ?? null).toBeNull()
  })

  it('does not let cleanup delete a session populated and shared after its scan', async () => {
    const f = await fixture()
    f.session.messages = []
    await f.store.save(f.session)
    const scanned = deferred(), resume = deferred()
    const scan = f.store.scanAll.bind(f.store)
    vi.spyOn(f.store, 'scanAll').mockImplementationOnce(async () => {
      const rows = await scan()
      scanned.resolve()
      await resume.promise
      return rows
    })
    const cleanup = f.service.cleanup(true)
    await scanned.promise
    f.session.messages = [{ role: 'user', content: 'new example' }]
    await f.store.save(f.session)
    await f.service.createShare('session')
    resume.resolve()
    await cleanup
    expect(await f.store.exists('session')).toBe(true)
    expect(await f.readable()).toHaveLength(1)
    await f.service.revokeShare('session')
    expect(await f.readable()).toHaveLength(0)
  })

  it('rereads after a queued delete and refuses publication', async () => {
    const f = await fixture()
    await f.service.createShare('session')
    const entered = deferred(), release = deferred()
    const put = f.documents.put.getMockImplementation() as DocumentBackend['put']
    f.documents.put.mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return put(...args)
    })
    const deletion = f.service.delete('session')
    await entered.promise
    const queued = deferred()
    const lock = f.store.withLock.bind(f.store)
    vi.spyOn(f.store, 'withLock').mockImplementation((...args) => { queued.resolve(); return lock(...args) })
    const creation = f.service.createShare('session')
    const refused = expect(creation).rejects.toMatchObject({ status: 404 })
    await queued.promise
    release.resolve()
    await Promise.all([deletion, refused])
    expect(await f.readable()).toHaveLength(0)
    expect(await f.store.exists('session')).toBe(false)
  })

  it('locks the resolved session identity for share aliases', async () => {
    const f = await fixture()
    await overlap(f, () => f.service.createShare('alias'))
    expect(f.records.size).toBe(1)
    await f.service.revokeShare('alias')
    expect(await f.readable()).toHaveLength(0)
  })

  it('never publishes a snapshot when session ownership persistence refuses', async () => {
    const f = await fixture()
    f.backend.write.mockRejectedValueOnce(new Error('ownership refused'))
    await expect(f.service.createShare('session')).rejects.toThrow('ownership refused')
    expect(await f.readable()).toHaveLength(0)
    expect((await f.store.get('session')).share_token).toBeNull()
    await f.service.createShare('session')
    await f.service.revokeShare('session')
    expect(await f.readable()).toHaveLength(0)
  })

  it.each([false, true])('keeps a failed snapshot publication owned, including a lost acknowledgement: %s', async (committed) => {
    const f = await fixture()
    const put = f.documents.put.getMockImplementation() as DocumentBackend['put']
    vi.mocked(f.documents.put).mockImplementationOnce(async (...args) => {
      if (committed) await put(...args)
      throw new Error('publication refused')
    })
    await expect(f.service.createShare('session')).rejects.toThrow('publication refused')
    const owner = await f.store.load('session')
    for (const token of f.records.keys()) expect(owner?.share_token).toBe(token)
    await f.service.revokeShare('session')
    expect(await f.readable()).toHaveLength(0)
  })

  it('does not clear ownership when snapshot revocation refuses', async () => {
    const f = await fixture()
    await f.service.createShare('session')
    const token = f.session.share_token
    vi.mocked(f.documents.put).mockRejectedValueOnce(new Error('revocation refused'))
    await expect(f.service.revokeShare('session')).rejects.toThrow('revocation refused')
    expect((await f.store.load('session'))?.share_token).toBe(token)
    await f.service.revokeShare('session')
    expect(await f.readable()).toHaveLength(0)
  })

  it('never revives the old token after revocation commits but clearing ownership refuses', async () => {
    const f = await fixture()
    await f.service.createShare('session')
    const oldToken = f.session.share_token!
    f.backend.write.mockRejectedValueOnce(new Error('clear refused'))
    await expect(f.service.revokeShare('session')).rejects.toThrow('clear refused')
    expect(await f.shares.load(oldToken)).toBeNull()
    f.store.sessions.clear()
    await f.service.createShare('session')
    expect(await f.shares.load(oldToken)).toBeNull()
    expect((await f.store.load('session'))?.share_token).not.toBe(oldToken)
    await f.service.revokeShare('session')
    expect(await f.readable()).toHaveLength(0)
  })

  it('rejects invisible profiles and invalid tokens without exposing snapshots', async () => {
    const f = await fixture()
    f.session.profile = 'other'
    await f.store.save(f.session)
    await expect(f.service.createShare('session')).rejects.toMatchObject({ status: 404 })
    await expect(f.service.revokeShare('session')).rejects.toMatchObject({ status: 404 })
    expect(f.records.size).toBe(0)
    expect(await f.shares.load('../invalid')).toBeNull()
  })
})
