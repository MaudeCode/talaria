import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session, type Message } from '../session.js'
import { ShareStore } from '../shares.js'
import { RevisionConflict, type StorageBackend } from './backend.js'
import { sessionSearchMatches, sessionSearchMessageText, sessionSearchTerms } from './search-text.js'
import { keepRecent } from '../../test/storage.js'

export interface SessionBackendFixture {
  storage: StorageBackend
  /** Fail the next commit after it has staged data but before publication. */
  failNextWrite: () => void
  cleanup: () => void | Promise<void>
}

/** Every adapter runs these same assertions against disposable storage. */
export function runSessionBackendConformance(name: string, makeStorage: () => SessionBackendFixture | Promise<SessionBackendFixture>): void {
  describe(`${name} session backend conformance`, () => {
    let fixture: SessionBackendFixture
    beforeEach(async () => { fixture = await makeStorage() })
    afterEach(async () => { await fixture.storage.close(); await fixture.cleanup() })
    const write = (rows: Message[], expected: string | null = null, sid = 'session') => fixture.storage.sessions.write(sid, { doc: { session_id: sid, title: 'Test', updated_at: 100 }, messages: { kind: 'replace', rows } }, expected)
    const read = (sid = 'session') => fixture.storage.sessions.readMessages(sid, { start: 0, end: Infinity })

    it('creates, reads metadata without messages, ranges and deletes', async () => {
      const sessions = fixture.storage.sessions
      expect(await sessions.exists('session')).toBe(false)
      expect(await sessions.readDocument('session')).toBeNull()
      const rows = [0, 1, 2].map((n) => ({ role: 'user', content: `row ${n}` }))
      const revision = await write(rows)
      expect(await sessions.exists('session')).toBe(true)
      const document = await sessions.readDocument('session')
      expect(document).toMatchObject({ doc: { session_id: 'session', title: 'Test' }, messages: rows, messageCount: 3, revision })
      expect(document?.doc).not.toHaveProperty('messages')
      for (const range of [{ start: 0, end: 0 }, { start: 1, end: 2 }, { start: 2, end: 9 }, { start: 9, end: 10 }, { start: 0, end: Infinity }]) {
        expect(await sessions.readMessages('session', range)).toEqual(rows.slice(range.start, range.end))
      }
      expect(await sessions.delete('session', { tombstone: false })).toBe(true)
      expect(await sessions.exists('session')).toBe(false)
      expect(await sessions.revision('session')).toBeNull()
      expect(await sessions.tombstones.has('session')).toBe(false)
    })

    it('writes its input as it was when the write was called, whatever the caller edits while it commits (TAL-1739)', async () => {
      const sessions = fixture.storage.sessions
      const rows: Message[] = [{ role: 'user', content: 'before' }]
      const calls = [{ name: 'before' }]
      const writing = sessions.write('session', { doc: { session_id: 'session', title: 'Test', updated_at: 100, tool_calls: calls }, messages: { kind: 'replace', rows }, all: rows }, null)
      rows[0]!.content = 'after'
      rows.push({ role: 'user', content: 'late' })
      calls[0]!.name = 'after'
      await writing
      expect(await sessions.readDocument('session')).toMatchObject({ doc: { tool_calls: [{ name: 'before' }] }, messages: [{ role: 'user', content: 'before' }], messageCount: 1 })
      expect((await sessions.readDocument('session', { metadataOnly: true }))?.messageCount).toBe(1)
    })

    it('serves a public share only while its owner exists, without loading or rewriting the session', async () => {
      const { sessions, documents } = fixture.storage
      const shares = new ShareStore(documents, () => 100, sessions)
      const revision = await write([{ role: 'user', content: 'synthetic' }])
      const owner = new Session({ session_id: 'session' }, { workspace: '', model: null, modelProvider: null })
      const { share_token: token } = await shares.createOrRefresh(owner, { title: 'Shared', messages: [{ role: 'user', content: 'synthetic' }], message_count: 1 })
      const loads = [vi.spyOn(sessions, 'readDocument'), vi.spyOn(sessions, 'readMessages')]
      expect(await shares.load(token)).toMatchObject({ title: 'Shared' })
      for (const load of loads) expect(load).not.toHaveBeenCalled()
      expect(await sessions.revision('session')).toBe(revision)
      await sessions.delete('session', { tombstone: false })
      expect(await shares.load(token)).toBeNull()
    })

    it('applies append, splice, replace and metadata-only writes with revision checks', async () => {
      const s = fixture.storage.sessions
      let rev = await write([{ content: 'a' }, { content: 'b' }])
      const doc = { session_id: 'session', title: 'changed' }
      for (const [messages, expected] of [
        [{ kind: 'append', rows: [{ content: 'c' }] }, ['a', 'b', 'c']],
        [{ kind: 'splice', from: 1, deleteCount: 1, rows: [{ content: 'x' }, { content: 'y' }] }, ['a', 'x', 'y', 'c']],
        [{ kind: 'unchanged' }, ['a', 'x', 'y', 'c']],
        [{ kind: 'replace', rows: [{ content: 'z' }] }, ['z']],
      ] as const) {
        const previous = rev
        rev = await s.write('session', { doc, messages: structuredClone(messages) as import('./backend.js').SessionChange['messages'] }, rev)
        expect(rev).not.toBe(previous)
        expect(await s.revision('session')).toBe(rev)
        expect(await s.revision('session')).toBe(rev)
        expect((await read()).map((m) => m.content)).toEqual(expected)
        await expect(write([{ content: 'stale' }], previous)).rejects.toBeInstanceOf(RevisionConflict)
        expect(await s.revision('session')).toBe(rev)
      }
    })

    it('leaves the previous revision readable when publication fails', async () => {
      const rows = [{ content: 'previous' }]
      const rev = await write(rows)
      fixture.failNextWrite()
      await expect(write([{ content: 'replacement' }], rev)).rejects.toThrow()
      expect(await fixture.storage.sessions.revision('session')).toBe(rev)
      expect(await read()).toEqual(rows)
    })

    it('restores and discards shrink backups and tracks tombstones', async () => {
      const s = fixture.storage.sessions
      const rows = [{ content: 'one' }, { content: 'two' }]
      const rev = await write(rows)
      await write(rows.slice(0, 1), rev)
      expect(await s.shrinkBackup.restore('session')).toBe(true)
      expect(await read()).toEqual(rows)
      await s.shrinkBackup.discard('session')
      expect(await s.shrinkBackup.restore('session')).toBe(false)
      await s.tombstones.add('another')
      await s.tombstones.add('another')
      await s.delete('session', { tombstone: true })
      expect(await s.tombstones.all()).toEqual(new Set(['another', 'session']))
      await s.tombstones.remove('another')
      expect(await s.tombstones.has('another')).toBe(false)
      expect(await s.tombstones.has('session')).toBe(true)
    })

    it('publishes index entries and a stable revision, then changes it on a new index', async () => {
      const s = fixture.storage.sessions
      await write([{ content: 'hello' }])
      const entries = [{ session_id: 'session', message_count: 1, updated_at: 100 }]
      await s.writeIndex(entries)
      const index = await s.index()
      expect(index.entries).toEqual(entries)
      expect(await s.index()).toEqual(index)
      await s.writeIndex([{ ...entries[0], message_count: 2 }])
      expect((await s.index()).revision).not.toBe(index.revision)
      expect(await s.ids()).toEqual(new Set(['session']))
    })

    it('never exposes a partial write to concurrent readers', async () => {
      const old = [{ content: 'old' }]
      const next = Array.from({ length: 20 }, (_, n) => ({ content: `É漢🙂 ${n} ${'x'.repeat(100_000)}` }))
      const rev = await write(old)
      const [before, , during] = await Promise.all([read(), write(next, rev), read()])
      for (const rows of [before, during]) expect([old, next]).toContainEqual(rows)
      expect(await read()).toEqual(next)
    })

    it('matches the reference text scan, including depth, unicode, text parts and first matches', async () => {
      const s = fixture.storage.sessions
      const rows: Message[] = [
        { role: 'user', content: [{ type: 'image', text: 'hidden-image' }, { type: 'text', text: 'ÉCHO' }, { type: 'text', text: 'Straße A' }] },
        { role: 'assistant', content: 'echo second ab' },
        { role: 'assistant', content: [{ type: 'tool_use', text: 'hidden-tool' }] },
        { role: 'user', content: 'filler' }, { role: 'assistant', content: 'at five' },
        { role: 'assistant', content: 'past depth echo' }, { role: 'assistant', content: 'echo second' },
      ]
      await write(rows)
      await write([{ content: 'echo deleted' }], null, 'deleted')
      await s.delete('deleted', { tombstone: true })
      for (const depth of [0, 1, 5]) for (const query of ['ÉCHO', 'écho straße', 'ß', 'a', 'ab', 'echo second', 'past depth', 'hidden-tool', 'hidden-image', 'absent']) {
        const terms = sessionSearchTerms(query)
        const candidates = await s.readMessages('session', { start: 0, end: depth || Infinity })
        const idx = candidates.findIndex((m) => sessionSearchMatches(sessionSearchMessageText(m), terms))
        const expected = idx < 0 ? new Map() : new Map([['session', { idx, text: sessionSearchMessageText(candidates[idx]) }]])
        expect(await s.searchMessages(['session', 'unknown', 'deleted'], terms, depth), `${query}, depth ${depth}`).toEqual(expected)
      }
      expect(await s.searchMessages([], ['echo'], 0)).toEqual(new Map())
    })

    it('finds no text held only in a hidden row, and keeps a later row at its index', async () => {
      const s = fixture.storage.sessions
      await write([
        { role: 'user', content: 'start' },
        { role: 'assistant', content: 'needle withheld', display_kind: 'hidden' },
        { role: 'user', content: [{ type: 'text', text: 'needle steered' }], display_kind: 'hidden' },
        { role: 'assistant', content: 'needle shown' },
      ])
      for (const query of ['withheld', 'steered', 'needle withheld']) expect(await s.searchMessages(['session'], sessionSearchTerms(query), 0), query).toEqual(new Map())
      expect(await s.searchMessages(['session'], sessionSearchTerms('needle'), 0)).toEqual(new Map([['session', { idx: 3, text: 'needle shown' }]]))
    })

    it('closes without losing committed data and rejects subsequent reads', async () => {
      await write([{ content: 'saved' }])
      await fixture.storage.close()
      await expect(fixture.storage.sessions.revision('session')).rejects.toThrow(/closed/i)
    })
  })
}

export interface DocumentBackendFixture {
  backend: import('./backend.js').DocumentBackend
  failNextWrite(): void
  cleanup(): void | Promise<void>
}

export function runDocumentBackendConformance(name: string, make: () => DocumentBackendFixture | Promise<DocumentBackendFixture>): void {
  describe(`${name} document backend conformance`, () => {
    let fixture: DocumentBackendFixture
    beforeEach(async () => { fixture = await make() })
    afterEach(async () => { await fixture.cleanup() })

    it('creates, lists, reads and conditionally deletes documents', async () => {
      const backend = fixture.backend
      expect(await backend.get('drafts', 'first')).toBeNull()
      expect(await backend.list('drafts')).toEqual([])
      const revision = await backend.put('drafts', 'first', { text: 'first', files: [] }, null)
      expect(await backend.get('drafts', 'first')).toEqual({ value: { text: 'first', files: [] }, revision })
      expect(await backend.list('drafts')).toEqual([{ key: 'first', revision }])
      expect(await backend.delete('drafts', 'first', revision)).toBe(true)
      expect(await backend.delete('drafts', 'first', null)).toBe(false)
      expect(await backend.get('drafts', 'first')).toBeNull()
    })

    it('rejects stale creation, replacement and deletion without changing committed data', async () => {
      const backend = fixture.backend
      const first = await backend.put('drafts', 'first', { text: 'first' }, null)
      const second = await backend.put('drafts', 'first', { text: 'second' }, first)
      for (const expected of [null, first]) {
        await expect(backend.put('drafts', 'first', { text: 'lost' }, expected)).rejects.toBeInstanceOf(RevisionConflict)
        await expect(backend.delete('drafts', 'first', expected)).rejects.toBeInstanceOf(RevisionConflict)
      }
      expect(await backend.get('drafts', 'first')).toEqual({ value: { text: 'second' }, revision: second })
    })

    it('publishes one winner under competing updates and preserves the old bytes after failed publication', async () => {
      const backend = fixture.backend
      const revision = await backend.put('drafts', 'first', { text: 'first' }, null)
      fixture.failNextWrite()
      await expect(backend.put('drafts', 'first', { text: 'partial' }, revision)).rejects.toThrow('injected publication failure')
      expect(await backend.get('drafts', 'first')).toEqual({ value: { text: 'first' }, revision })
      const results = await Promise.allSettled(['a', 'b'].map((text) => backend.put('drafts', 'first', { text }, revision)))
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      const failed = results.find((result) => result.status === 'rejected')
      expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(RevisionConflict)
    })

    it('bounds document reads before parsing an oversized value', async () => {
      await fixture.backend.put('drafts', 'first', { text: 'x'.repeat(100) }, null)
      await expect(fixture.backend.get('drafts', 'first', { maxBytes: 32 })).rejects.toMatchObject({ reason: 'too-large' })
      expect((await fixture.backend.get('drafts', 'first'))?.value).toEqual({ text: 'x'.repeat(100) })
    })

    it('isolates namespaces and refuses traversal keys', async () => {
      await fixture.backend.put('drafts', 'same', { text: 'draft' }, null)
      await fixture.backend.put('shares', 'same', { title: 'share' }, null)
      expect((await fixture.backend.get('drafts', 'same'))?.value).toEqual({ text: 'draft' })
      expect((await fixture.backend.get('shares', 'same'))?.value).toEqual({ title: 'share' })
      for (const key of ['..', '../outside', '/outside']) await expect(fixture.backend.put('drafts', key, {}, null)).rejects.toThrow()
    })
  })
}

export interface JournalBackendFixture {
  backend: import('./backend.js').JournalBackend
  /** Backend-specific reads and edits of a run's stored form, for the archival cases. */
  store: JournalStoreProbe
  /** A second backend over the same storage, as a restarted server opens it. */
  reopen(): import('./backend.js').JournalBackend | Promise<import('./backend.js').JournalBackend>
  cleanup(): void | Promise<void>
}

export interface JournalStoreProbe {
  /** Dates the run's live rows (seconds), as if last written then. */
  age(sid: string, rid: string, at: number): void | Promise<void>
  /** Whether the run still has live rows. */
  live(sid: string, rid: string): Promise<boolean>
  /** The run's live rows as archival compacts them: newline-terminated, byte for byte. */
  liveBytes(sid: string, rid: string): Promise<Buffer>
  /** The run's archive inflated, or null when it has none. */
  archive(sid: string, rid: string): Promise<Buffer | null>
  /** The archive's stored (compressed) size. */
  archiveSize(sid: string, rid: string): Promise<number>
  /** Dates the archive (seconds), which orders the archive budget's removals. */
  ageArchive(sid: string, rid: string, at: number): void | Promise<void>
  /** Removes the summary stored with the run's archive. */
  dropSummary(sid: string, rid: string): void | Promise<void>
  /** Understates the archive's recorded size so a replay reaches the archive instead of refusing up front; a no-op where none is recorded. */
  understateArchive(sid: string, rid: string): void | Promise<void>
}

export function runJournalBackendConformance(name: string, make: (env?: Record<string, string>) => JournalBackendFixture | Promise<JournalBackendFixture>): void {
  describe(`${name} journal backend conformance`, () => {
    let fixture: JournalBackendFixture
    const extra: JournalBackendFixture[] = []
    beforeEach(async () => { fixture = await make() })
    afterEach(async () => { for (const f of [fixture, ...extra.splice(0)]) { await f.backend.close(); await f.cleanup() } })
    /** Another fixture with its own storage and environment, cleaned up with the test. */
    const another = async (env?: Record<string, string>): Promise<JournalBackendFixture> => { const f = await make(env); extra.push(f); return f }
    const rows = async (from = 1): Promise<import('../journal.js').JournalEvent[]> => {
      const result: import('../journal.js').JournalEvent[] = []
      for await (const row of fixture.backend.read('session', 'stream', from)) result.push(row)
      return result
    }

    it.each(['eager', 'terminal-only'] as const)('keeps contiguous cursors across reopen with %s durability', async (durability) => {
      const backend = fixture.backend
      expect(await backend.summary('session', 'stream')).toBeNull()
      let writer = await backend.open('session', 'stream', { durability })
      await writer.append({ event: 'token', payload: { text: 'first' } }, { terminal: false })
      await writer.close()
      writer = await backend.open('session', 'stream', { durability })
      const terminal = await writer.append({ event: 'done', payload: {} }, { terminal: true })
      expect(terminal).toMatchObject({ seq: 2, event_id: 'stream:2', terminal: true })
      expect(await backend.summary('session', 'stream')).toMatchObject({ last_seq: 2, terminal: true })
      expect((await rows()).map((row) => row.event_id)).toEqual(['stream:1', 'stream:2'])
      expect((await rows(2)).map((row) => row.event_id)).toEqual(['stream:2'])
      expect(await rows(3)).toEqual([])
      expect(await backend.streams('session')).toEqual(['stream'])
      await writer.close()
    })

    it('rejects journal ids that could escape their namespace', async () => {
      for (const sid of ['.', '..', '../outside']) await expect(fixture.backend.open(sid, 'stream', { durability: 'eager' })).rejects.toThrow()
    })

    it('supports a reader while its writer appends', async () => {
      const writer = await fixture.backend.open('session', 'stream', { durability: 'terminal-only' })
      await writer.append({ event: 'token', payload: { text: 'first' } }, { terminal: false })
      const reader = fixture.backend.read('session', 'stream', 1)[Symbol.asyncIterator]()
      const first = await reader.next()
      expect(first.done ? null : first.value.event_id).toBe('stream:1')
      await writer.append({ event: 'token', payload: { text: 'second' } }, { terminal: false })
      const second = await reader.next()
      expect(second.done ? null : second.value.event_id).toBe('stream:2')
      await reader.return?.()
      await writer.close()
    })

    it('preserves active runs, archives closed terminal runs with their rows, and deletes them', async () => {
      const backend = fixture.backend
      const writer = await backend.open('session', 'stream', { durability: 'terminal-only' })
      await writer.append({ event: 'done', payload: {} }, { terminal: true })
      const cutoff = Date.now() / 1000 + 1
      expect(await backend.prune(cutoff)).toBe(0)
      await writer.close()
      const before = await rows()
      expect(await backend.prune(cutoff)).toBe(1)
      expect(await rows()).toEqual(before)
      expect(await backend.summary('session', 'stream')).toMatchObject({ terminal: true, last_seq: 1 })
      expect(await backend.prune(cutoff), 'an archived run is not archived again').toBe(0)
      expect(await backend.streams('session')).toEqual(['stream'])
      expect(await backend.deleteSession('session')).toBe(true)
      expect(await backend.summary('session', 'stream')).toBeNull()
      expect(await rows()).toEqual([])
      expect(await backend.streams('session')).toEqual([])
    })

    const DAY = 86400
    const old = Date.now() / 1000 - 30 * DAY
    /** Large Unicode text with the raw separators a line splitter other than `\n` would break on. */
    const UNICODE = `🌲 é 中文 \u0085     `.repeat(12_000)
    const writeRun = async (f: JournalBackendFixture, sid: string, rid: string, opts: { at?: number; terminal?: boolean; text?: string } = {}): Promise<void> => {
      const writer = await f.backend.writer(sid, rid)
      await writer.appendSseEvent('token', { text: opts.text ?? 'hi' })
      await writer.appendSseEvent('tool', { name: 'read', tid: 't1' })
      if (opts.terminal ?? true) await writer.appendSseEvent('done', { session_id: sid })
      await writer.close()
      await f.store.age(sid, rid, opts.at ?? old)
    }
    const runs = async (f: JournalBackendFixture, sid: string, count: number, at = old): Promise<void> => {
      for (let i = 0; i < count; i += 1) await writeRun(f, sid, `run${String(i)}`, { at: at + i })
    }
    const live = (f: JournalBackendFixture, sid: string, count: number): Promise<boolean[]> => Promise.all([...Array(count).keys()].map((i) => f.store.live(sid, `run${String(i)}`)))
    const sweep = (backend: import('./backend.js').JournalBackend, opts: import('../journal.js').PruneOptions = {}) => backend.pruneSettled({ now: Date.now() / 1000, retentionSeconds: 14 * DAY, maxRuns: 0, maxBytes: 0, ...opts })
    /** Everything a reader observes about a run and its session. */
    const observe = async (backend: import('./backend.js').JournalBackend, sid: string, rid: string) => {
      const { path: _path, ...found } = { ...(await backend.findRunSummary(rid)) }
      const replay = await backend.readSessionRunEvents(sid, `${rid}:1`)
      return {
        rows: await backend.readRunEvents(sid, rid),
        after: await backend.readRunEvents(sid, rid, { afterSeq: 1, maxSeq: 2 }),
        tail: await backend.readRunEventTail(sid, rid, 1024, 2),
        found,
        latest: await backend.latestRunSummary(sid, rid),
        replay: { status: replay.status, events: replay.events },
        missing: (await backend.readSessionRunEvents(sid, `${rid}:99`)).status,
        streams: await backend.streams(sid),
      }
    }

    it.each([
      ['age', {}],
      ['count', { retentionSeconds: 365 * DAY, maxRuns: 1 }],
      ['bytes', { retentionSeconds: 365 * DAY, maxBytes: 8192 }],
    ] as const)('a run archived by %s replays identically, before and after a restart', async (_reason, opts) => {
      const { backend, store } = fixture
      await writeRun(fixture, 'session', 'run', { text: UNICODE })
      await writeRun(fixture, 'session', 'next', { at: Date.now() / 1000, text: 'x'.repeat(2048) })
      const original = await store.liveBytes('session', 'run')
      const before = await observe(backend, 'session', 'run')
      expect(before.rows.map((e) => e.event_id)).toEqual(['run:1', 'run:2', 'run:3'])
      expect(before.replay.status).toBe('ok')
      expect(await sweep(backend, opts)).toMatchObject({ pruned: 1, bytes_reclaimed: original.length })
      expect(await store.live('session', 'run')).toBe(false)
      expect(await store.live('session', 'next'), 'only the due run is archived').toBe(true)
      expect((await store.archive('session', 'run'))?.equals(original), 'the archive repeats the live rows byte for byte').toBe(true)
      expect(await observe(backend, 'session', 'run')).toEqual(before)
      expect(await observe(await fixture.reopen(), 'session', 'run'), 'a restarted server reads the same run').toEqual(before)
    })

    it('stops a session replay at its byte budget before assembling an archived row', async () => {
      await writeRun(fixture, 'session', 'run', { text: 'x'.repeat(6 * 1024 * 1024) })
      await sweep(fixture.backend)
      await fixture.store.understateArchive('session', 'run')
      const concat = vi.spyOn(Buffer, 'concat')
      try {
        expect((await fixture.backend.readSessionRunEvents('session', 'run:1')).status).toBe('replay_limit_bytes')
        const largest = Math.max(0, ...concat.mock.results.map((r) => (r.value as Buffer).length))
        expect(largest, 'no buffer past the 4 MiB replay budget').toBeLessThanOrEqual(4 * 1024 * 1024)
      } finally { concat.mockRestore() }
    })

    it('archives the oldest runs past a soft budget, above the keep-recent floor', async () => {
      const fresh = Date.now() / 1000 - 60
      const one = await another(keepRecent(1))
      await runs(one, 'count', 6, fresh)
      await writeRun(one, 'count', 'open', { terminal: false, at: fresh - 10 })
      expect(await sweep(one.backend, { maxRuns: 4 })).toMatchObject({ pruned: 3 })
      expect(await live(one, 'count', 6), 'the oldest settled runs go first').toEqual([false, false, false, true, true, true])
      expect(await one.store.live('count', 'open'), 'a nonterminal run is never archived').toBe(true)
      // The keep-recent floor wins over the budget, which stays soft.
      const three = await another(keepRecent(3))
      await runs(three, 'floor', 5, fresh)
      expect(await sweep(three.backend, { maxRuns: 1 })).toMatchObject({ pruned: 2 })
      expect(await live(three, 'floor', 5)).toEqual([false, false, true, true, true])
      // Bytes: archive until the session's live bytes fit.
      await runs(fixture, 'bytes', 4, fresh)
      const each = (await fixture.store.liveBytes('bytes', 'run0')).length
      expect(await sweep(fixture.backend, { maxBytes: each * 2 + 64 })).toMatchObject({ pruned: 2 })
      expect(await live(fixture, 'bytes', 4)).toEqual([false, false, true, true])
      // Equal ages keep the run that sorts last.
      const ties = await another()
      for (const rid of ['a', 'b', 'c']) await writeRun(ties, 'ties', rid, { at: fresh })
      expect(await sweep(ties.backend, { maxRuns: 1 })).toMatchObject({ pruned: 2 })
      expect(await Promise.all(['a', 'b', 'c'].map((rid) => ties.store.live('ties', rid)))).toEqual([false, false, true])
    })

    it('keeps runs the session still names, and whole sessions whose state is unreadable', async () => {
      await runs(fixture, 'named', 3)
      await runs(fixture, 'unreadable', 2)
      await runs(fixture, 'throws', 2)
      const protectedRuns = (sid: string): Promise<Set<string> | null> => {
        if (sid === 'throws') return Promise.reject(new Error('EIO'))
        return Promise.resolve(sid === 'unreadable' ? null : new Set(['run1']))
      }
      expect(await sweep(fixture.backend, { protectedRuns })).toMatchObject({ pruned: 2 })
      expect(await live(fixture, 'named', 3)).toEqual([false, true, false])
      expect(await live(fixture, 'unreadable', 2)).toEqual([true, true])
      expect(await live(fixture, 'throws', 2)).toEqual([true, true])
      // A run the session starts naming while it is archived stays live.
      const late = await another()
      await runs(late, 'late', 1)
      let calls = 0
      expect(await sweep(late.backend, { protectedRuns: () => Promise.resolve(new Set(++calls > 1 ? ['run0'] : [])) })).toMatchObject({ pruned: 0 })
      expect(await late.store.live('late', 'run0')).toBe(true)
      expect((await late.backend.readRunEvents('late', 'run0')).length).toBe(3)
    })

    it('removes the oldest archives past the instance archive budget, keeping their summaries', async () => {
      const { backend, store } = fixture
      const sessions = ['a', 'b', 'c', 'd', 'e']
      for (const [i, sid] of sessions.entries()) {
        await writeRun(fixture, sid, 'run', { text: `${sid} `.repeat(4000) })
        await sweep(backend)
        await store.ageArchive(sid, 'run', old + i)
      }
      // `b` gained a live continuation, which still needs its archived prefix; `c` lost its summary.
      const writer = await backend.writer('b', 'run')
      await writer.appendSseEvent('token', { text: 'continuation' })
      await writer.close()
      await store.dropSummary('c', 'run')
      const budget = await store.archiveSize('d', 'run') + await store.archiveSize('e', 'run')
      const year = { retentionSeconds: 365 * DAY }
      expect(await sweep(backend, { ...year, maxArchiveBytes: 0 }), 'zero turns the budget off').toMatchObject({ archives_removed: 0 })
      expect(await sweep(backend, { ...year, maxArchiveBytes: budget })).toMatchObject({ archives_removed: 3 })
      expect(await Promise.all(sessions.map(async (sid) => (await store.archive(sid, 'run')) !== null))).toEqual([false, true, true, false, false])
      // The removed run reads as pruned history: its summary stays and replay honestly reports it unavailable.
      expect(await backend.latestRunSummary('a', 'run')).toMatchObject({ journal_pruned: true, terminal: true, last_seq: 3 })
      expect(await backend.readRunEvents('a', 'run')).toEqual([])
      expect((await backend.readSessionRunEvents('a', 'run:1')).status).toBe('cursor_pruned')
      expect((await backend.readRunEvents('b', 'run')).map((e) => e.seq)).toEqual([1, 2, 3, 4])
    })
  })
}
