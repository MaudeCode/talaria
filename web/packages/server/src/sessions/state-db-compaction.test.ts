import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fixture from '../test/fixtures/compaction-replay.json' with { type: 'json' }
import { mergeSessionMessagesAppendOnly, stateDbSeenId } from './merge.js'
import { stateDbSessionRead } from './state-db.js'
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
    db = new DatabaseSync(path); load('compacted')
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
