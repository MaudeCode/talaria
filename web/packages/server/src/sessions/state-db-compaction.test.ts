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

  it('does not claim copy provenance from a logical UID alone on a legacy Agent', () => {
    // v0.21.6 cannot distinguish a compacted unobserved edit from an unchanged replay.
    // The version contract is required for UID-based suppression; retain the old timestamp rule here.
    expect(replay()._state_db_row_id).toBe(9)
    expect(mergeSessionMessagesAppendOnly(fixture.before, stateDbSessionRead(path, sid).rows, { stateDbSeenId: 5 })).toHaveLength(7)
  })

  it('keeps a changed legacy rewind while matching an unchanged timestamp twin', () => {
    db.exec('UPDATE messages SET compacted = 0 WHERE id = 1; UPDATE messages SET timestamp = 1000 WHERE id = 9')
    expect(replay()._state_db_row_id).toBe(9)
    db.exec("UPDATE messages SET content = 'Refactor the parser please' WHERE id = 9")
    expect(stateDbSessionRead(path, sid).rows.at(-1)?._state_db_row_id).toBe(1)
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
