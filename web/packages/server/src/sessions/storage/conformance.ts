import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '../session.js'
import { RevisionConflict, type StorageBackend } from './backend.js'
import { sessionSearchMatches, sessionSearchMessageText, sessionSearchTerms } from './search-text.js'

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
  cleanup(): void | Promise<void>
}

export function runJournalBackendConformance(name: string, make: () => JournalBackendFixture | Promise<JournalBackendFixture>): void {
  describe(`${name} journal backend conformance`, () => {
    let fixture: JournalBackendFixture
    beforeEach(async () => { fixture = await make() })
    afterEach(async () => { await fixture.backend.close(); await fixture.cleanup() })
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
  })
}
