import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fixture from '../test/fixtures/compaction-replay.json' with { type: 'json' }
import carrier from '../test/fixtures/compaction-carrier.json' with { type: 'json' }
import { bootTestServer, openStateDb } from '../test/harness.js'
import { Session } from './session.js'
import { markerKind, mergeSessionMessagesAppendOnly, stateDbSeenId } from './merge.js'
import { stateDbSessionRead, stateDbSessionTailRead } from './state-db.js'
import { stripPublicInternalFields } from '../redact.js'

describe('released Agent compaction replay identity (TAL-783)', () => {
  let dir: string
  let path: string
  let db: DatabaseSync
  const sid = fixture.sessionId
  const header = '[STILL IN PROGRESS — this is the active request, restated after the compaction boundary because it was not finished yet. Continue it; do not start over.]'
  const read = () => stateDbSessionRead(path, sid).rows
  const load = (stage: keyof typeof fixture.snapshots, nullableActive = false) => {
    db.exec('PRAGMA foreign_keys = OFF; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS system_prompts;')
    const schema = nullableActive ? fixture.schema.map((line) => line.replace('active INTEGER NOT NULL', 'active INTEGER')) : fixture.schema
    db.exec([...schema, ...fixture.snapshots[stage]].join('\n'))
    return read()
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compaction-replay-')); path = join(dir, 'state.db')
    db = openStateDb(path); load('compacted')
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it.each(['compacted', 'twiceCompacted'] as const)('adds only the summary after %s, preserving the model-facing replay', (stage) => {
    const rows = load(stage)
    const merged = mergeSessionMessagesAppendOnly(fixture.before, rows, { stateDbSeenId: 5 })
    expect(merged).toHaveLength(6)
    expect(merged.slice(0, 5)).toEqual(fixture.before)
    expect(merged[5]?.content).toMatch(/^\[CONTEXT COMPACTION/)
    expect(rows.at(-1)).toMatchObject({ _state_db_row_id: 1, content: `${header}\nRefactor the parser please` })
    expect(rows.at(-1)).not.toHaveProperty('message_uid')
  })

  it.each(['compacted', 'twiceCompacted'] as const)('dedupes %s without a durable seen marker', (stage) => {
    const rows = load(stage)
    for (const options of [{}, { stateDbSeenId: null }]) {
      const merged = mergeSessionMessagesAppendOnly(fixture.before, rows, options)
      expect(merged).toHaveLength(6)
      expect(merged.slice(0, 5)).toEqual(fixture.before)
      expect(merged[5]?.content).toMatch(/^\[CONTEXT COMPACTION/)
    }
  })

  it('keeps an unseen edited replay and recognizes it on later reads without a marker', () => {
    const edited = load('editedThenCompacted')
    const merged = mergeSessionMessagesAppendOnly(fixture.before, edited)
    expect(merged.filter((m) => m.role === 'user')).toHaveLength(3)
    expect(merged.at(-1)?.content).toContain('Only fix the parser error')
    const repeated = mergeSessionMessagesAppendOnly(merged, load('editedTwiceCompacted'))
    expect(repeated.filter((m) => m.role === 'user')).toEqual(merged.filter((m) => m.role === 'user'))
    // A legacy local transcript may hold the authored edit but no numeric row identity.
    const authored = { role: 'user', content: 'Only fix the parser error', timestamp: 3000 }
    expect(mergeSessionMessagesAppendOnly([...fixture.before, authored], edited).filter((m) => m.role === 'user')).toEqual([...fixture.before.filter((m) => m.role === 'user'), authored])
  })

  it('retains clear, truncate and compression boundaries when deduping unmarked replays', () => {
    const original = load('initial')[0]!
    const rows = load('compacted')
    expect(mergeSessionMessagesAppendOnly(fixture.before, rows, { truncationWatermark: 1004 })).toEqual(fixture.before)
    expect(mergeSessionMessagesAppendOnly(fixture.before, rows, { truncationWatermark: 1004, compressedWatermark: true })).toHaveLength(6)
    expect(mergeSessionMessagesAppendOnly([], [original, ...rows], { truncationWatermark: 0 })).toEqual([])
    const empty = mergeSessionMessagesAppendOnly([], [original, ...rows])
    expect(empty.filter((m) => m.role === 'user')).toEqual([original])
    const prefix = mergeSessionMessagesAppendOnly([], [original, ...rows], { truncationWatermark: 1004 })
    expect(prefix.every((m) => Number(m.timestamp) <= 1004)).toBe(true)
    expect(prefix.filter((m) => m.role === 'user')).toEqual([original])
    expect(stripPublicInternalFields(rows, { messageRecords: true })).not.toHaveProperty('3._state_db_source_key')
  })

  it('keeps an unobserved edit after both active generations are compacted, then dedupes later copies', () => {
    const rows = load('editedThenCompacted')
    const authored = db.prepare("SELECT id FROM messages WHERE content = 'Only fix the parser error' ORDER BY id DESC LIMIT 1").get()!
    expect(rows.at(-1)?._state_db_row_id).toBe(authored.id)
    const merged = mergeSessionMessagesAppendOnly(fixture.before, rows, { stateDbSeenId: 5 })
    expect(merged.filter((m) => m.role === 'user')).toHaveLength(3)
    expect(merged.at(-1)?.content).toContain('Only fix the parser error')
    const again = load('editedTwiceCompacted')
    expect(again.at(-1)?._state_db_row_id).toBe(authored.id)
    const repeated = mergeSessionMessagesAppendOnly(merged, again, { stateDbSeenId: stateDbSeenId(rows) })
    expect(repeated.filter((m) => m.role === 'user')).toEqual(merged.filter((m) => m.role === 'user'))
  })

  it.each([1000, 3000])('keeps an edited active generation beside its predecessor at timestamp %s', (timestamp) => {
    const rows = load('editedActive')
    const id = rows.at(-1)!._state_db_row_id as number
    db.prepare('UPDATE messages SET timestamp = ? WHERE id = ?').run(timestamp, id)
    const current = read()
    expect(current.at(-2)?._state_db_row_id).toBe(1)
    expect(current.at(-1)?._state_db_row_id).toBe(id)
    expect(mergeSessionMessagesAppendOnly(fixture.before, current, { stateDbSeenId: 5 }).filter((m) => m.role === 'user')).toHaveLength(3)
  })

  it('does not cross an intervening edit when the text and timestamp return to an older value', () => {
    const previous = load('editedTwiceCompacted')
    const local = mergeSessionMessagesAppendOnly(fixture.before, previous, { stateDbSeenId: 5 })
    const reverted = load('reverted')
    expect(reverted.at(-1)?._state_db_row_id).toBe(db.prepare('SELECT MAX(id) AS id FROM messages').get()!.id)
    expect(mergeSessionMessagesAppendOnly(local, reverted, { stateDbSeenId: stateDbSeenId(previous) }).at(-1)?.content).toBe('Refactor the parser please')
  })

  it.each([1000, 3000])('keeps an edited rewind at timestamp %s and recognizes only its exact replay body', (timestamp) => {
    db.exec('UPDATE messages SET active = 0, compacted = 0 WHERE id = 9')
    const id = Number(db.prepare('INSERT INTO messages(session_id, role, content, timestamp, message_uid) VALUES (?, ?, ?, ?, ?)').run(sid, 'user', 'Only fix the parser error', timestamp, 'fixture-1').lastInsertRowid)
    expect(read().at(-1)?._state_db_row_id).toBe(id)
    db.prepare('UPDATE messages SET active = 0, compacted = 1 WHERE id = ?').run(id)
    db.prepare('INSERT INTO messages(session_id, role, content, timestamp, message_uid) VALUES (?, ?, ?, ?, ?)').run(sid, 'user', `${header}\nOnly fix the parser error`, 4000, 'fixture-1')
    expect(read().at(-1)?._state_db_row_id).toBe(id)
  })

  it('keeps the existing tool-result identity when compaction prunes its text', () => {
    db.exec("UPDATE messages SET content = '[pruned tool output]' WHERE id = 8")
    expect(read().find((m) => m.role === 'tool')).toMatchObject({ _state_db_row_id: 5, content: '[pruned tool output]' })
  })

  it('preserves changed tool calls even if the UID, text and timestamp are unchanged', () => {
    const calls = [{ id: 'call_read', type: 'function', function: { name: 'read_other_file', arguments: '{}' } }]
    const id = Number(db.prepare('INSERT INTO messages(session_id, role, content, timestamp, message_uid, tool_calls) SELECT session_id, role, content, timestamp, message_uid, ? FROM messages WHERE id = 7').run(JSON.stringify(calls)).lastInsertRowid)
    expect(read().at(-1)).toMatchObject({ _state_db_row_id: id, tool_calls: calls })
    expect(mergeSessionMessagesAppendOnly(fixture.before, read(), { stateDbSeenId: 5 }).at(-1)?.tool_calls).toEqual(calls)
  })

  it('appends one unseen edited version even when two active rows carry it', () => {
    const rows = load('editedActive')
    const merged = mergeSessionMessagesAppendOnly(fixture.before, [...rows, rows.at(-1)!], { stateDbSeenId: 5 })
    expect(merged.filter((m) => m.content === 'Only fix the parser error')).toHaveLength(1)
    expect(stripPublicInternalFields([merged.at(-1)!], { messageRecords: true })).not.toHaveProperty('0._state_db_authored_change')
  })

  it.each([null, 2])('handles active=%s without a separate archive join per live row', (active) => {
    load('compacted', active === null) // Older reconciled stores can have a nullable active column.
    db.prepare('UPDATE messages SET active = ? WHERE id = 9').run(active)
    expect(read().at(-1)?._state_db_row_id).toBe(1)
  })

  it('does not treat changed replay text or unrelated UIDs as a copy', () => {
    db.prepare('UPDATE messages SET content = ? WHERE id = 9').run(`${header}\nA different request`)
    expect(read().at(-1)?._state_db_row_id).toBe(9)
    db.prepare('UPDATE messages SET message_uid = ?, content = ? WHERE id = 9').run('unrelated', `${header}\nRefactor the parser please`)
    expect(read().at(-1)?._state_db_row_id).toBe(9)
  })

  it.each(['null', 'backfilled', 'absent'])('retains the legacy timestamp rule for %s UIDs', (mode) => {
    db.exec('UPDATE messages SET timestamp = 1000 WHERE id = 9')
    if (mode === 'null') db.exec('UPDATE messages SET message_uid = NULL')
    if (mode === 'backfilled') db.exec("UPDATE messages SET message_uid = 'backfilled-' || id")
    if (mode === 'absent') db.exec('DROP INDEX idx_messages_session_uid; ALTER TABLE messages DROP COLUMN message_uid')
    expect(read().at(-1)?._state_db_row_id).toBe(1)
  })

  it('matches repeated multimodal restatements only while every original part is unchanged', () => {
    load('multimodal')
    const mediaRead = () => stateDbSessionRead(path, 'media').rows.at(-1)!
    const original = db.prepare("SELECT MIN(id) AS id FROM messages WHERE session_id = 'media'").get()!.id
    expect(mediaRead()._state_db_row_id).toBe(original)
    const content = mediaRead().content as Record<string, unknown>[]
    expect(content).toHaveLength(4) // Two replay headers plus the original text and image.
    content[3] = { type: 'image_url', image_url: { url: 'data:image/png;base64,BB==' } }
    const latest = db.prepare("SELECT MAX(id) AS id FROM messages WHERE session_id = 'media'").get()!.id as number
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('\0json:' + JSON.stringify(content), latest)
    expect(mediaRead()._state_db_row_id).toBe(latest)
  })

  it('matches only within the selected continuation chain', () => {
    db.exec("INSERT INTO sessions(id, source, started_at) VALUES('parent', 'webui', 900); UPDATE messages SET session_id = 'parent' WHERE id = 1")
    expect(read().at(-1)?._state_db_row_id).toBe(9)
    expect(stateDbSessionRead(path, sid, { lineage: ['parent', sid] }).rows.at(-1)?._state_db_row_id).toBe(1)
  })
})

// TAL-1259: recorded through v0.22.3's real carrier merge and archive_and_compact.
describe('released Agent kept-message compaction carrier', () => {
  let dir: string, path: string, db: DatabaseSync
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compaction-carrier-'))
    path = join(dir, 'state.db'); db = openStateDb(path)
    db.exec([...carrier.schema, ...carrier.snapshots.compacted].join('\n'))
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  it.each([undefined, null, 4])('shows each reply once and one compaction card with seen ID %s', (seenId) => {
    const read = stateDbSessionRead(path, carrier.sessionId)
    expect(read.ok).toBe(true)
    const options = seenId === undefined ? {} : { stateDbSeenId: seenId }
    const merged = mergeSessionMessagesAppendOnly(carrier.before, read.rows, options)
    expect(merged.filter((m) => !markerKind(m))).toEqual(carrier.before)
    expect(merged.filter((m) => markerKind(m))).toHaveLength(1)
    expect(merged.at(-1)?.content).toBe(carrier.summary)
    expect(mergeSessionMessagesAppendOnly(merged, read.rows, options)).toEqual(merged)
  })

  it('keeps the carrier summary and anchor coherent in a bounded tail read', () => {
    const full = stateDbSessionRead(path, carrier.sessionId)
    const tail = stateDbSessionTailRead(path, carrier.sessionId, 4)
    expect(tail.rows).toEqual(full.rows)
    const summary = tail.rows.find((m) => markerKind(m))!
    expect(summary).toMatchObject({ _state_db_row_id: 5, content: carrier.summary })
    expect(tail.rows[0]).toMatchObject({ _state_db_row_id: 2, content: carrier.before[1]!.content })
    expect(tail.rows[0]).not.toHaveProperty('_state_db_authored_change')
    expect(stateDbSessionTailRead(path, carrier.sessionId, 5).anchor).toEqual(summary)
    expect(mergeSessionMessagesAppendOnly(carrier.before, tail.rows, { stateDbSeenId: 4 })).toHaveLength(5)
    const truncated = mergeSessionMessagesAppendOnly(carrier.before, full.rows, { truncationWatermark: 1003 })
    expect(truncated).toEqual(carrier.before)
  })

  it.each(['unflagged', 'unknown-wrapper', 'changed-reply', 'whitespace'] as const)('preserves %s content rather than inferring a copy from the UID', (mode) => {
    if (mode === 'unflagged') db.exec('UPDATE messages SET _compressed_summary = 0 WHERE id = 5')
    if (mode === 'unknown-wrapper') db.exec("UPDATE messages SET content = 'Unknown compaction format' WHERE id = 5")
    if (mode === 'changed-reply') db.exec("UPDATE messages SET content = replace(content, 'I will inspect the parser.', 'An authored change.') WHERE id = 5")
    if (mode === 'whitespace') db.exec("UPDATE messages SET content = replace(content, 'I will inspect the parser.', '  Indented reply.  ') WHERE id IN (2, 5)")
    const rows = stateDbSessionRead(path, carrier.sessionId).rows
    const merged = mergeSessionMessagesAppendOnly(carrier.before, rows, { stateDbSeenId: 4 })
    if (mode === 'whitespace') {
      expect(rows[0]).toMatchObject({ content: '  Indented reply.  ', _state_db_row_id: 2 })
      expect(merged).toHaveLength(5)
    } else {
      expect(rows[0]?._state_db_authored_change).toBe(true)
      expect(merged.filter((m) => !markerKind(m))).toHaveLength(5)
    }
    expect(rows.filter((m) => markerKind(m))).toHaveLength(mode === 'unflagged' || mode === 'unknown-wrapper' ? 0 : 1)
  })

  it('exposes one marked summary on full and paginated detail after a durable seen boundary', async () => {
    const server = await bootTestServer()
    const store = openStateDb(join(server.state, 'state.db'))
    try {
      store.exec([...carrier.schema, ...carrier.snapshots.initial].join('\n'))
      const initial = stateDbSessionRead(join(server.state, 'state.db'), carrier.sessionId)
      const session = new Session({ session_id: carrier.sessionId, messages: carrier.before, context_messages: carrier.before }, { workspace: server.state, model: null })
      server.deps.sessions.markStateDbSeen(session, initial)
      await server.deps.sessionStore.save(session)
      store.exec('PRAGMA foreign_keys = OFF; DROP TABLE messages; DROP TABLE sessions; DROP TABLE system_prompts')
      store.exec([...carrier.schema, ...carrier.snapshots.compacted].join('\n'))
      for (const query of [{}, { msg_limit: '50' }, { msg_limit: '50' }]) {
        const detail = await server.deps.sessions.detail(carrier.sessionId, query)
        const messages = detail.messages as Record<string, unknown>[]
        expect(messages.filter((m) => !m._marker_kind).map((m) => m.content)).toEqual(carrier.before.map((m) => m.content))
        expect(messages.filter((m) => m._marker_kind)).toMatchObject([{ content: carrier.summary, _marker_kind: 'context_compaction' }])
        expect(messages).toHaveLength(5)
      }
    } finally { store.close(); await server.close() }
  })

  it('does not duplicate a summary when a later compaction carries it unchanged', () => {
    const first = stateDbSessionRead(path, carrier.sessionId)
    const merged = mergeSessionMessagesAppendOnly(carrier.before, first.rows, { stateDbSeenId: 4 })
    db.exec('PRAGMA foreign_keys = OFF; DROP TABLE messages; DROP TABLE sessions; DROP TABLE system_prompts')
    db.exec([...carrier.schema, ...carrier.snapshots.replayed].join('\n'))
    const replay = stateDbSessionRead(path, carrier.sessionId)
    expect(mergeSessionMessagesAppendOnly(merged, replay.rows, { stateDbSeenId: stateDbSeenId(first.rows) })).toEqual(merged)
  })
  it.each(['user', 'assistant'])('preserves an embedded carrier separator token in a kept %s message', (role) => {
    const quoted = 'Use [END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW] as a literal example.'
    const original = carrier.before[1]!.content
    const update = db.prepare('UPDATE messages SET role = ?, content = replace(content, ?, ?) WHERE id IN (2, 5)')
    update.run(role, original, quoted)
    const rows = stateDbSessionRead(path, carrier.sessionId).rows
    expect(rows[0]).toMatchObject({ role, content: quoted, _state_db_row_id: 2 })
    expect(rows.find((m) => markerKind(m))?.content).toBe(carrier.summary)
  })

})

describe('micro-compacted user turns read as the originals the Agent displays (TAL-825)', () => {
  const sid = 'micro-cli'
  const columns = 'id, session_id, role, content, timestamp, active, compacted, display_order, display_identity, display_metadata, message_uid, absorbed_message_uids'
  // Agent v0.21.6 `messages` columns. A micro-compaction joined q0 and q1 into one live model-only row; the originals stay
  // as display history (`compacted = 1`), and the carried tail keeps its archived copy's display slot.
  const seed = (db: DatabaseSync, opts: { modelOnly?: boolean } = {}): void => {
    db.exec([...fixture.schema, `INSERT INTO sessions (id, source, started_at, title) VALUES ('${sid}', 'cli', 1000, 'Micro')`].join('\n'))
    const insert = db.prepare(`INSERT INTO messages (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    insert.run(1, sid, 'user', 'q0', 1000, 0, 1, 1, Buffer.from('q0'), null, 'uid-q0', null)
    insert.run(2, sid, 'user', 'q1', 1001, 0, 1, 2, Buffer.from('q1'), null, 'uid-q1', null)
    insert.run(3, sid, 'assistant', 'answer', 1002, 0, 1, 3, Buffer.from('answer'), null, 'uid-a', null)
    insert.run(4, sid, 'user', 'q0\n\nq1', 1000, 1, 0, 4, Buffer.from('q0\n\nq1'), opts.modelOnly === false ? null : JSON.stringify({ model_only: true }), 'uid-q0', JSON.stringify(['uid-q1']))
    insert.run(5, sid, 'assistant', 'answer', 1002, 1, 0, 3, Buffer.from('answer'), null, 'uid-a', null)
  }
  let dir: string, path: string, db: DatabaseSync
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'micro-compaction-')); path = join(dir, 'state.db'); db = openStateDb(path) })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const contents = (rows: Record<string, unknown>[]): unknown[] => rows.map((m) => m.content)

  it('shows q0 and q1 as separate user rows, no merged row, and the carried tail once', () => {
    seed(db)
    const display = stateDbSessionRead(path, sid, { display: true })
    expect(contents(display.rows)).toEqual(['q0', 'q1', 'answer'])
    const live = stateDbSessionRead(path, sid)
    // The default read (model context, merges) is unchanged: the tip's live rows.
    expect(contents(live.rows)).toEqual(['q0\n\nq1', 'answer'])
    // The tail's representative is its live copy, with the identity the default read gives it.
    expect(display.rows.at(-1)?._state_db_row_id).toBe(live.rows.at(-1)?._state_db_row_id)
    expect(display.model).toEqual(live.rows)
  })

  it('reads one row per display group when no row is model-only (Agent v0.21.4)', () => {
    seed(db, { modelOnly: false })
    expect(contents(stateDbSessionRead(path, sid, { display: true }).rows)).toEqual(['q0', 'q1', 'answer', 'q0\n\nq1'])
  })

  it('falls back to the active rows while a visible row is unindexed', () => {
    seed(db)
    db.exec('UPDATE messages SET display_order = NULL WHERE id = 2')
    const display = stateDbSessionRead(path, sid, { display: true })
    expect(display.rows).toEqual(stateDbSessionRead(path, sid).rows)
    expect(display.model).toBeUndefined()
  })

  it('falls back to the active rows without the display columns', () => {
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, tool_call_id TEXT)")
    db.exec(`INSERT INTO sessions VALUES ('${sid}', 'cli', 1000); INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES ('${sid}', 'user', 'q0', 1000, 0, 1), ('${sid}', 'user', 'q0 q1', 1000, 1, 0)`)
    const display = stateDbSessionRead(path, sid, { display: true })
    expect(contents(display.rows)).toEqual(['q0 q1'])
    expect(display.rows).toEqual(stateDbSessionRead(path, sid).rows)
  })

  it('serves the originals for a CLI session without a sidecar and keeps the claim on the model rows', async () => {
    const server = await bootTestServer()
    const store = openStateDb(join(server.state, 'state.db'))
    try {
      seed(store)
      const res = await server.get(`/api/session?session_id=${sid}`)
      expect(res.status).toBe(200)
      const messages = ((await res.json()) as { session: { messages: Record<string, unknown>[] } }).session.messages
      expect(contents(messages)).toEqual(['q0', 'q1', 'answer'])
      const { session, reason } = await server.deps.sessions.claimOrSynthesizeCliSession(sid)
      expect(reason).toBe('materialized')
      expect(contents(session!.messages)).toEqual(['q0', 'q1', 'answer'])
      expect(session!.context_messages).toEqual(stateDbSessionRead(join(server.state, 'state.db'), sid).rows)
      expect(contents(session!.context_messages)).toContain('q0\n\nq1')
    } finally { store.close(); await server.close() }
  })
})
