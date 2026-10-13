import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fixture from '../test/fixtures/compaction-replay.json' with { type: 'json' }
import { mergeSessionMessagesAppendOnly } from './merge.js'
import { stateDbSessionRead } from './state-db.js'

describe('compaction replay identity (TAL-783)', () => {
  let dir: string
  let path: string
  let db: DatabaseSync
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compaction-replay-'))
    path = join(dir, 'state.db')
    db = new DatabaseSync(path)
    db.exec(fixture.sql.join("\n"))
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  const sid = fixture.sessionId
  const replay = () => stateDbSessionRead(path, sid).rows.find((row) => String(row.content).startsWith('[STILL IN PROGRESS'))!

  it('merges the Agent v0.21.6 mid-turn replay to six rows without a new user bubble', () => {
    const read = stateDbSessionRead(path, sid)
    expect(read.ok).toBe(true)
    const merged = mergeSessionMessagesAppendOnly(fixture.before, read.rows, { stateDbSeenId: 5 })
    expect(merged).toHaveLength(6)
    expect(merged.slice(0, 5)).toEqual(fixture.before)
    expect(merged[5]?.content).toMatch(/^\[CONTEXT COMPACTION/)
    expect(merged.some((row) => String(row.content).startsWith('[STILL IN PROGRESS'))).toBe(false)
    expect(mergeSessionMessagesAppendOnly(merged, read.rows, { stateDbSeenId: 5 })).toEqual(merged)
  })

  it('maps the replay to its original id while preserving the model-facing row', () => {
    expect(replay()).toMatchObject({ _state_db_row_id: 1, role: 'user' })
    expect(Number(replay().timestamp)).toBeGreaterThan(2000)
    expect(replay().content).toContain('Refactor the parser please')
    expect(replay()).not.toHaveProperty('message_uid')
  })

  it('prefers the oldest UID match over a coincidental timestamp twin and later generations', () => {
    db.exec('UPDATE messages SET active = 0, compacted = 1 WHERE id = 9')
    db.exec("INSERT INTO messages (session_id, role, content, timestamp, active, compacted, message_uid) VALUES ('compaction-replay', 'user', 'later replay', 3000, 1, 0, 'fixture-1')")
    // A different archived request shares the new timestamp. UID identity must win.
    db.exec('UPDATE messages SET timestamp = 3000 WHERE id = 3')
    expect(stateDbSessionRead(path, sid).rows.at(-1)).toMatchObject({ content: 'later replay', _state_db_row_id: 1 })
  })

  it('matches across the selected continuation chain but never another session', () => {
    db.exec("INSERT INTO sessions (id, source, started_at) VALUES ('parent', 'webui', 900)")
    db.exec("UPDATE messages SET session_id = 'parent' WHERE id = 1")
    expect(replay()._state_db_row_id).toBe(9)
    const read = stateDbSessionRead(path, sid, { lineage: ['parent', sid] })
    expect(read.rows.at(-1)?._state_db_row_id).toBe(1)
  })

  it('keeps a nonzero live flag eligible for UID matching', () => {
    db.prepare('UPDATE messages SET active = ? WHERE id = 9').run(2)
    expect(replay()._state_db_row_id).toBe(1)
  })

  it('does not suppress an edited rewind just because it reuses the UID', () => {
    db.exec('UPDATE messages SET compacted = 0 WHERE id = 1')
    db.exec('UPDATE messages SET timestamp = 1000 WHERE id = 9')
    expect(replay()._state_db_row_id).toBe(9)
    expect(mergeSessionMessagesAppendOnly(fixture.before, stateDbSessionRead(path, sid).rows, { stateDbSeenId: 5 })).toHaveLength(7)
    // An unchanged rewind still follows the existing timestamp/content rule.
    db.exec("UPDATE messages SET content = 'Refactor the parser please' WHERE id = 9")
    expect(stateDbSessionRead(path, sid).rows.at(-1)?._state_db_row_id).toBe(1)
  })

  it('keeps an edited rewind after earlier compactions and dedupes its subsequent replay', () => {
    // The original remains compacted, but the immediate predecessor was rewound.
    db.exec('UPDATE messages SET active = 0, compacted = 0 WHERE id = 9')
    db.exec("INSERT INTO messages (session_id, role, content, timestamp, message_uid) VALUES ('compaction-replay', 'user', 'Only fix the parser error', 3000, 'fixture-1')")
    const read = stateDbSessionRead(path, sid)
    const merged = mergeSessionMessagesAppendOnly(fixture.before, read.rows, { stateDbSeenId: 9 })
    expect(merged.at(-1)?.content).toBe('Only fix the parser error')
    expect(read.rows.at(-1)?._state_db_row_id).toBe(10)

    // A later compaction may dedupe to the edit, but never to its pre-rewind ancestor.
    db.exec('UPDATE messages SET active = 0, compacted = 1 WHERE id = 10')
    db.exec("INSERT INTO messages (session_id, role, content, timestamp, message_uid) VALUES ('compaction-replay', 'user', 'Restated parser fix', 4000, 'fixture-1')")
    const reread = stateDbSessionRead(path, sid)
    expect(reread.rows.at(-1)?._state_db_row_id).toBe(10)
    expect(mergeSessionMessagesAppendOnly(merged, reread.rows, { stateDbSeenId: 10 })).toEqual(merged)
  })

  it.each(['null', 'backfilled', 'absent'])('retains timestamp twins for %s UIDs', (mode) => {
    db.exec('UPDATE messages SET timestamp = 1000 WHERE id = 9')
    if (mode === 'null') db.exec('UPDATE messages SET message_uid = NULL')
    if (mode === 'backfilled') db.exec("UPDATE messages SET message_uid = 'backfilled-' || id")
    if (mode === 'absent') db.exec('DROP INDEX idx_messages_session_uid; ALTER TABLE messages DROP COLUMN message_uid')
    expect(replay()._state_db_row_id).toBe(1)
  })

  it('leaves a genuinely new UID and timestamp beyond the seen boundary', () => {
    db.exec("UPDATE messages SET message_uid = 'new-request' WHERE id = 9")
    expect(replay()._state_db_row_id).toBe(9)
  })
})
