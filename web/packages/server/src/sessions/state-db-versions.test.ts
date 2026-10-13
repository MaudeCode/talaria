import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fixture from '../test/fixtures/versioned-compaction.json' with { type: 'json' }
import { mergeSessionMessagesAppendOnly } from './merge.js'
import { stateDbSessionRead } from './state-db.js'
import { Session } from './session.js'
import { bootTestServer } from '../test/harness.js'

describe('durable Agent message versions (TAL-783)', () => {
  let dir: string
  let path: string
  let db: DatabaseSync
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'message-versions-')); path = join(dir, 'state.db'); db = new DatabaseSync(path) })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const sid = fixture.sessionId
  const load = (name: keyof typeof fixture.snapshots) => {
    db.exec('PRAGMA foreign_keys = OFF; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS message_versions; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS system_prompts;')
    db.exec([...fixture.schema, ...fixture.snapshots[name]].join('\n'))
    return stateDbSessionRead(path, sid)
  }

  it('keeps an edit compacted before its first read distinct from the original request', () => {
    const initial = load('initial')
    const edited = load('editedThenCompacted')
    const merged = mergeSessionMessagesAppendOnly(initial.rows, edited.rows, { stateDbSeenId: 5 })
    const users = merged.filter((m) => m.role === 'user')
    expect(users).toHaveLength(3)
    expect(users.at(-1)?.content).toContain('Only fix the parser error')
    expect(users.at(-1)?._state_db_row_id).toBe(7)
    expect(edited.seenId).toBe(8)
    expect(mergeSessionMessagesAppendOnly(merged, edited.rows, { stateDbSeenId: edited.seenId ?? null })).toEqual(merged)
  })

  it('adds only the summary for an unchanged mid-turn compaction', () => {
    const read = load('compacted')
    const merged = mergeSessionMessagesAppendOnly(fixture.before, read.rows, { stateDbSeenId: 5 })
    expect(merged).toHaveLength(6)
    expect(merged.slice(0, 5)).toEqual(fixture.before)
    expect(merged[5]?.content).toMatch(/^\[CONTEXT COMPACTION/)
    expect(read.rows.at(-1)?._state_db_row_id).toBe(1)
    expect(read.rows.at(-1)?.content).toContain('[STILL IN PROGRESS')
    expect(read.rows.at(-1)).not.toHaveProperty('message_version_uid')
  })

  it('advances an in-place edit cursor and keeps it through destructive replacement', () => {
    const before = load('editedThenCompacted')
    const rewritten = load('rewritten')
    const added = mergeSessionMessagesAppendOnly(before.rows, rewritten.rows, { stateDbSeenId: before.seenId ?? null })
    expect(added.at(-1)?.content).toBe('Only fix the parser error and add tests')
    expect(rewritten.seenId).toBe(9)
    expect(rewritten.rows.at(-1)?._state_db_row_id).toBe(9)
    const replaced = load('replaced')
    expect(replaced.rows).toEqual(rewritten.rows)
    expect(replaced.seenId).toBe(rewritten.seenId)
  })

  it('never aliases equal numeric IDs from different identity generations', () => {
    const local = [{ role: 'user', content: 'old', timestamp: 1, _state_db_row_id: 1, _state_db_generation: 'physical' }]
    const state = [{ role: 'user', content: 'edited', timestamp: 2, _state_db_row_id: 1, _state_db_generation: 'versions' }]
    expect(mergeSessionMessagesAppendOnly(local, state, { stateDbSeenId: 0 })).toEqual([...local, ...state])
  })

  it('appends an unseen version only once when two active rows copy it', () => {
    const read = load('editedThenCompacted')
    expect(mergeSessionMessagesAppendOnly(fixture.before, [...read.rows, read.rows.at(-1)!], { stateDbSeenId: 5 })).toHaveLength(7)
  })

  it('uses only versions from the selected session lineage', () => {
    load('compacted')
    db.exec("INSERT INTO sessions (id, source, started_at) VALUES ('parent', 'webui', 900); UPDATE message_versions SET session_id = 'parent' WHERE id = 1; INSERT INTO message_versions(session_id, message_uid, version_uid) SELECT session_id, message_uid, message_version_uid FROM messages WHERE id = 9")
    expect(stateDbSessionRead(path, sid).rows.at(-1)?._state_db_row_id).toBe(7)
    expect(stateDbSessionRead(path, sid, { lineage: ['parent', sid] }).rows.at(-1)?._state_db_row_id).toBe(1)
  })

  it('does not lose an old-timestamp edit when a saved marker crosses identity schemes', async () => {
    const initial = load('initial')
    const server = await bootTestServer()
    try {
      const session = new Session({ session_id: sid, messages: initial.rows }, { workspace: dir, model: null })
      const legacy = initial.rows.map((m) => ({ ...m, _state_db_generation: 'legacy' }))
      server.deps.sessions.markStateDbSeen(session, { rows: legacy, ok: true, idCapable: true })
      const edit = { ...initial.rows[0]!, content: 'Previously unseen edit', _state_db_row_id: 7 }
      expect(server.deps.sessions.mergedTranscript(session, session.messages, [...initial.rows, edit]).at(-1)?.content).toBe('Previously unseen edit')
      // An in-flight turn must not cover that edit as its own work using an old numeric cursor.
      server.deps.sessions.settleStateDb(session, { turnId: 'turn', previousContext: legacy, start: { id: 20, generation: 'legacy' }, read: { ...initial, rows: [...initial.rows, edit], seenId: 7 } })
      expect(session.messages.at(-1)?.content).toBe('Previously unseen edit')
    } finally { await server.close() }
  })

  it('retains the durable seen boundary after its physical anchor disappears', async () => {
    load('editedThenCompacted')
    const server = await bootTestServer()
    try {
      const session = new Session({ session_id: sid, messages: [...fixture.before] }, { workspace: dir, model: null })
      server.deps.sessions.markStateDbSeen(session, stateDbSessionRead(path, sid))
      // Delete every physical row. Ledger arrival history remains for the owning session.
      db.exec('DELETE FROM messages')
      server.deps.sessions.markStateDbSeen(session, stateDbSessionRead(path, sid))
      expect(session.state_db_seen_id).toBe(8)
      load('replaced')
      expect(server.deps.sessions.mergedTranscript(session, session.messages, stateDbSessionRead(path, sid).rows).at(-1)?.content).toBe('Only fix the parser error and add tests')
    } finally { await server.close() }
  })
})
