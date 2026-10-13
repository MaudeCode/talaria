import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stateDbSessionRead, stateDbTailToolContent } from './state-db.js'

const prefix = '\0json:'
const fixtures = [
  { name: 'wrapped literal', stored: prefix + JSON.stringify(prefix + 'x'), decoded: prefix + 'x' },
  { name: 'wrapped array-looking literal', stored: prefix + JSON.stringify(prefix + '[1,2]'), decoded: prefix + '[1,2]' },
  { name: 'parts', stored: prefix + '[{"type":"text","text":"hello"}]', decoded: [{ type: 'text', text: 'hello' }] },
  { name: 'object', stored: prefix + '{"text":"hello"}', decoded: { text: 'hello' } },
  { name: 'null', stored: prefix + 'null', decoded: null },
  { name: 'number', stored: prefix + '42', decoded: 42 },
  { name: 'boolean', stored: prefix + 'false', decoded: false },
  { name: 'malformed marker', stored: prefix + 'broken', decoded: prefix + 'broken' },
  { name: 'plain text', stored: 'hello', decoded: 'hello' },
]

describe('Agent state.db content decoding', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'state-db-content-'))
    path = join(dir, 'state.db')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it.each(fixtures)('reads $name through session projection and the tool tail', ({ stored, decoded }) => {
    const db = new DatabaseSync(path)
    try {
      db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
      const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
      for (const [i, role] of ['user', 'assistant', 'tool'].entries()) insert.run(i + 1, 'test', role, stored, i)
    } finally {
      db.close()
    }
    const read = stateDbSessionRead(path, 'test', { stitch: false })
    expect(read.ok).toBe(true)
    expect(read.rows.map((row) => row.content)).toEqual([decoded, decoded, decoded])
    expect(stateDbTailToolContent(path, 'test')).toBe(typeof decoded === 'string' ? decoded : null)
  })
})
