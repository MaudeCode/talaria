import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insightsSessionRows, readImportableAgentSessionRows, stateDbLocalTarget, stopStateDbWorker } from './state-db.js'

describe('session activity query plans with stale statistics (TAL-910)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'talaria-activity-plans-'))
  const path = join(dir, 'state.db')

  beforeAll(() => {
    const db = new DatabaseSync(path)
    try {
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL, title TEXT, message_count INTEGER,
        chat_id TEXT, user_id TEXT, session_key TEXT, model_config TEXT, parent_session_id TEXT, end_reason TEXT, ended_at REAL);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
        CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
        CREATE INDEX idx_messages_session_id ON messages(session_id, id);
        BEGIN`)
      const session = db.prepare('INSERT INTO sessions (id, source, started_at, title, message_count) VALUES (?, ?, ?, ?, 400)')
      const message = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      for (let i = 0; i < 300; i += 1) {
        const id = `s-${i}`
        session.run(id, i % 4 === 0 ? 'cron' : 'cli', i * 1000, `Session ${i}`)
        for (let j = 0; j < 400; j += 1) message.run(id, j % 2 ? 'assistant' : 'user', 'synthetic transcript', i * 1000 + j)
      }
      // Simulate ANALYZE predating the competing index, then reload the planner's statistics.
      db.exec("COMMIT; ANALYZE; DELETE FROM sqlite_stat1 WHERE idx = 'idx_messages_session_id'; ANALYZE sqlite_schema")
      expect(db.prepare("SELECT idx FROM sqlite_stat1 WHERE tbl = 'messages'").all()).toEqual([{ idx: 'idx_messages_session' }])
    } finally { db.close() }
  })
  afterAll(async () => { await stopStateDbWorker(); rmSync(dir, { recursive: true, force: true }) })

  // Observe the real reader's SQL and explain it on the same connection and snapshot.
  function activityPlans(read: () => unknown): string[] {
    const details: string[] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to the observed connection with .call below.
    const prepare = DatabaseSync.prototype.prepare
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes('SELECT MAX(')) {
        const params = Array<null>(sql.split('?').length - 1).fill(null)
        const plan = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
        details.push(...plan.map((r) => r.detail).filter((detail) => /^SEARCH (lm|mx|m) USING /.test(detail)))
      }
      return prepare.call(this, sql)
    })
    try { read(); return details } finally { spy.mockRestore() }
  }

  it.each([
    ['bounded listing', () => readImportableAgentSessionRows(path, { limit: 40 }), ['m', 'mx', 'lm']],
    ['unbounded listing', () => readImportableAgentSessionRows(path, { limit: null }), ['m', 'lm']],
    ['cron listing', () => readImportableAgentSessionRows(path, { limit: 40, includeSources: ['cron'], excludeSources: null }), ['m', 'mx', 'lm']],
    ['insights selection and cutoff', () => insightsSessionRows(path, 100_000), ['m', 'm']],
    ['local lineage ordering', () => stateDbLocalTarget(path, 's-1'), ['m']],
  ] as const)('uses the covering timestamp index for %s', (_name, read, aliases) => {
    const plans = activityPlans(read)
    expect(new Set(plans)).toEqual(new Set(aliases.map((alias) => `SEARCH ${alias} USING COVERING INDEX idx_messages_session (session_id=?)`)))
  })

  it('preserves rows, recency, insights cutoffs and legacy fallback without the timestamp index', () => {
    const read = (): unknown[] => [
      readImportableAgentSessionRows(path, { limit: 40 }),
      readImportableAgentSessionRows(path, { limit: null }),
      readImportableAgentSessionRows(path, { limit: 40, includeSources: ['cron'], excludeSources: null }),
      insightsSessionRows(path, 298_400),
      stateDbLocalTarget(path, 's-1'),
    ]
    const before = read()
    expect((before[0] as { id: string; last_activity: number }[])[0]).toMatchObject({ id: 's-299', last_activity: 299_399 })
    expect((before[2] as { id: string }[])[0]?.id).toBe('s-296')
    expect((before[3] as { session_id: string }[]).map((r) => r.session_id)).toEqual(['s-299'])
    const db = new DatabaseSync(path)
    try { db.exec('DROP INDEX idx_messages_session') } finally { db.close() }
    expect(read()).toEqual(before)
  })
})
