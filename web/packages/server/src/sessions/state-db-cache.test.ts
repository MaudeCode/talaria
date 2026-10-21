import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRowsExisting, cheapChangeFingerprint, countConversationRounds, insightsSessionRows, latestCronSessionInfo, readImportableAgentSessionRows, stateDbCompressionLineage, stateDbCronJobIds, stateDbHasSession, stateDbLineageReport, stateDbLocalTarget, stateDbSessionRow, stateDbSessionSources, stateDbSessionRead, stateDbStorage, stateDbTailToolContent, stateDbWebDiagnosticIds, stopStateDbWorker } from './state-db.js'

const observed = vi.hoisted(() => ({ handles: [] as import('node:sqlite').DatabaseSync[], probes: [] as string[], executions: [] as string[], rowCounts: new Map<string, number>() }))
vi.mock('node:sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:sqlite')>()
  class ObservedDatabase extends real.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof real.DatabaseSync>) {
      super(...args)
      if (args[1]?.readOnly) observed.handles.push(this)
    }
    override prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
      if (/PRAGMA (table_info|index_list)/i.test(sql)) observed.probes.push(sql)
      return new Proxy(super.prepare(sql), {
        get(target, key) {
          const value: unknown = Reflect.get(target, key)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            if (['get', 'all', 'iterate'].includes(String(key))) observed.executions.push(sql)
            const result: unknown = Reflect.apply(value, target, args)
            const countRows = (count: number): void => { observed.rowCounts.set(sql, (observed.rowCounts.get(sql) ?? 0) + count) }
            if (Array.isArray(result)) countRows(result.length)
            if (key !== 'iterate') return result
            return (function* () {
              for (const row of result as Iterable<unknown>) { countRows(1); yield row }
            })()
          }
        },
      })
    }
  }
  return { ...real, DatabaseSync: ObservedDatabase }
})

function seed(path: string, id = 'cli-a'): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, title TEXT, message_count INTEGER, model TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
      CREATE INDEX idx_messages_session ON messages(session_id, timestamp)`)
    db.prepare("INSERT INTO sessions (id, source, started_at, title, message_count) VALUES (?, 'cli', 100, ?, 2)").run(id, id)
    db.prepare("INSERT INTO messages VALUES (1, ?, 'user', 'hi', 101), (2, ?, 'assistant', 'hello', 102)").run(id, id)
  } finally { db.close() }
}

describe('state.db handle and schema reuse', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'talaria-db-cache-'))
    path = join(dir, 'state.db')
    seed(path)
    observed.handles.length = 0
    observed.probes.length = 0
  })
  afterEach(async () => { await stopStateDbWorker(); rmSync(dir, { recursive: true, force: true }) })

  it('reuses one handle until the path is replaced, then closes the old handle', () => {
    expect(readImportableAgentSessionRows(path).map((r) => r.id)).toEqual(['cli-a'])
    expect(readImportableAgentSessionRows(path).map((r) => r.id)).toEqual(['cli-a'])
    expect(observed.handles.length).toBe(1)
    const old = observed.handles[0]!
    const replacement = join(dir, 'replacement.db')
    seed(replacement, 'cli-b')
    renameSync(replacement, path)
    expect(readImportableAgentSessionRows(path).map((r) => r.id)).toEqual(['cli-b'])
    expect(observed.handles.length).toBe(2)
    expect(old.isOpen).toBe(false)
  })

  it('memoizes columns and indexes until schema_version changes', () => {
    readImportableAgentSessionRows(path)
    const first = [...observed.probes]
    expect(first).toContain('PRAGMA table_info(sessions)')
    expect(first).toContain('PRAGMA index_list(messages)')
    readImportableAgentSessionRows(path)
    expect(observed.probes).toEqual(first)
    const writer = new DatabaseSync(path)
    try {
      writer.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT DEFAULT '/synthetic'; CREATE INDEX idx_messages_session_user ON messages(session_id) WHERE role = 'user'")
      readImportableAgentSessionRows(path)
      expect(stateDbSessionRow(path, 'cli-a')?.cwd).toBe('/synthetic')
      expect(observed.probes).toEqual([...first, ...first])
      readImportableAgentSessionRows(path)
      expect(observed.probes).toEqual([...first, ...first])
      expect(observed.handles.length).toBe(1)
    } finally { writer.close() }
  })

  it('ends each reader snapshot, including early returns and query errors', () => {
    const reads = [
      () => readImportableAgentSessionRows(path), () => stateDbLocalTarget(path, 'cli-a'),
      () => stateDbSessionSources(path, ['cli-a']), () => stateDbSessionRead(path, 'cli-a'),
      () => stateDbCompressionLineage(path, 'cli-a'), () => stateDbLineageReport(path, 'cli-a'),
      () => stateDbSessionRow(path, 'cli-a'), () => stateDbStorage(path),
      () => stateDbHasSession(path, 'cli-a'), () => agentSessionRowsExisting(path, ['cli-a']),
      () => stateDbWebDiagnosticIds(path), () => countConversationRounds(path, 'cli-a'),
      () => stateDbTailToolContent(path, 'cli-a'), () => cheapChangeFingerprint(path),
      () => stateDbCronJobIds(path), () => latestCronSessionInfo(path, ['job-a'], []),
      () => insightsSessionRows(path, 0), () => readImportableAgentSessionRows(path, { limit: 0 }),
    ]
    for (const read of reads) {
      read()
      const db = observed.handles.at(-1)!
      expect(db.isOpen).toBe(true)
      expect(() => { db.exec('BEGIN; COMMIT') }).not.toThrow()
    }
    const handle = observed.handles[0]!
    const prepare = handle.prepare.bind(handle)
    const failed = vi.spyOn(handle, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('SELECT ') && sql.includes('FROM messages')) throw new Error('synthetic query failure')
      return prepare(sql)
    })
    try {
      const read = stateDbSessionRead(path, 'cli-a')
      expect(read.ok).toBe(false)
      expect(read.reason).toContain('synthetic query failure')
    } finally { failed.mockRestore() }
    expect(() => { handle.exec('BEGIN; COMMIT') }).not.toThrow()
    const writer = new DatabaseSync(path)
    try { writer.exec('DROP TABLE messages') } finally { writer.close() }
    expect(stateDbSessionRead(path, 'cli-a').ok).toBe(false)
    expect(() => { observed.handles.at(-1)!.exec('BEGIN; COMMIT') }).not.toThrow()
    expect(observed.handles.length).toBe(1)
  })

  it('sees new WAL commits without reopening and restores each callers busy timeout', () => {
    const writer = new DatabaseSync(path)
    try {
      writer.exec('PRAGMA journal_mode=WAL')
      readImportableAgentSessionRows(path)
      cheapChangeFingerprint(path)
      const db = observed.handles[0]!
      expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 500 })
      writer.exec("UPDATE sessions SET title = 'committed'")
      expect(readImportableAgentSessionRows(path)[0]?.title).toBe('committed')
      expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
      expect(observed.handles.length).toBe(1)
    } finally { writer.close() }
  })

  it('keeps different database paths and their schema caches separate', () => {
    const other = join(dir, 'other.db')
    seed(other, 'cli-other')
    readImportableAgentSessionRows(path)
    expect(readImportableAgentSessionRows(other).map((r) => r.id)).toEqual(['cli-other'])
    expect(readImportableAgentSessionRows(path).map((r) => r.id)).toEqual(['cli-a'])
    expect(observed.handles.length).toBe(2)
  })

  it('bounds open handles while deleted profile paths accumulate and keeps active paths warm', async () => {
    readImportableAgentSessionRows(path)
    const active = observed.handles[0]!
    for (let i = 0; i < 32; i += 1) {
      const retired = join(dir, `retired-${String(i)}.db`)
      seed(retired)
      readImportableAgentSessionRows(retired)
      rmSync(retired)
      readImportableAgentSessionRows(path)
      expect(observed.handles.filter((db) => db.isOpen).length).toBeLessThanOrEqual(16)
      expect(active.isOpen).toBe(true)
    }
    expect(observed.handles.length).toBe(33)
    expect(observed.handles[1]!.isOpen).toBe(false)
    await stopStateDbWorker()
    expect(observed.handles.filter((db) => db.isOpen).length).toBe(0)
  })

  it('closes direct-reader handles at shutdown and can reopen afterward', async () => {
    readImportableAgentSessionRows(path)
    const db = observed.handles[0]!
    expect(db.isOpen).toBe(true)
    await stopStateDbWorker()
    expect(db.isOpen).toBe(false)
    readImportableAgentSessionRows(path)
    expect(observed.handles.length).toBe(2)
  })

  it('walks 200 ownership lineages once and batches metadata keys', () => {
    const db = new DatabaseSync(path)
    const ids = Array.from({ length: 200 }, (_, i) => `child-${String(i)}`)
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
        ALTER TABLE sessions ADD COLUMN end_reason TEXT;
        ALTER TABLE sessions ADD COLUMN created_source TEXT;
        ALTER TABLE sessions ADD COLUMN chat_id TEXT;
        CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT)`)
      const insert = db.prepare('INSERT INTO sessions (id, source, parent_session_id, end_reason, created_source, chat_id) VALUES (?, ?, ?, ?, ?, ?)')
      const meta = db.prepare('INSERT INTO state_meta VALUES (?, ?)')
      for (const [i, id] of ids.entries()) {
        const parent = `parent-${String(i)}`
        const owner = `owner-${String(i)}`
        insert.run(parent, 'cli', null, 'compression', i % 2 ? 'kanban' : 'cli', owner)
        insert.run(id, 'cli', parent, null, 'cli', owner)
        meta.run(`gateway.local_policy.v1:${owner}`, JSON.stringify({ session_id: owner, entry: { session_id: id }, lineage: [parent, id], policy: { source: i % 2 ? 'kanban' : 'cli', safe_mode: true } }))
        meta.run(`gateway.api.binding.v1.${id}`, '{}')
        meta.run(`gateway.retired_session.v1.${parent}`, '{}')
      }
    } finally { db.close() }
    observed.executions.length = 0
    expect(stateDbSessionSources(path, ids)).toEqual(new Map(ids.map((id, i) => [id, { source: i % 2 ? 'kanban' : 'cli', canonical: true, execution_mode: 'safe' }])))
    const selects = observed.executions.filter((sql) => sql.includes('FROM sessions WHERE id = ?'))
    expect.soft(selects.length, 'one point select per requested lineage segment').toBeLessThanOrEqual(400)
    const meta = observed.executions.filter((sql) => sql.includes('FROM state_meta'))
    expect(meta.length, 'three keys per candidate, in batches of 400').toBeLessThanOrEqual(Math.ceil(600 * 3 / 400))
  })

  it.each([
    ['session_admissions', 200], ['session_admissions', 801],
    ['worker_executions', 200], ['worker_executions', 801],
  ] as const)('scans %s lineages once across %i candidates without returning unrelated history', (table, count) => {
    const db = new DatabaseSync(path)
    const ids = Array.from({ length: count }, (_, i) => `candidate-${String(i)}`)
    const column = table === 'session_admissions' ? 'target_session_id' : 'session_id'
    try {
      db.exec(`CREATE TABLE ${table} (${column} TEXT, lineage_json TEXT); CREATE INDEX ledger_target ON ${table} (${column})`)
      const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?)`)
      insert.run(ids[0]!, null)
      insert.run('pruned-owner', JSON.stringify(ids.slice(1)))
      db.exec('BEGIN')
      for (let i = 0; i < 10_000; i += 1) insert.run(`unrelated-owner-${String(i)}`, JSON.stringify([`unrelated-segment-${String(i)}`]))
      db.exec('COMMIT')
    } finally { db.close() }
    observed.executions.length = 0
    observed.rowCounts.clear()
    expect(stateDbSessionSources(path, ids)).toEqual(new Map(ids.map((id) => [id, { source: '', canonical: true }])))
    const scans = observed.executions.filter((sql) => sql.includes(`FROM ${table}`) && (sql.includes('lineage_json') || sql.includes('json_each')))
    expect(scans, 'one lineage scan regardless of candidate chunk count').toHaveLength(1)
    expect(observed.rowCounts.get(scans[0]!), 'only matching lineage rows cross into JavaScript').toBe(1)
  })

  it('keeps receipt alias precedence in candidate order across metadata batches', () => {
    const db = new DatabaseSync(path)
    try {
      db.exec('CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT)')
      const meta = db.prepare('INSERT INTO state_meta VALUES (?, ?)')
      for (const [owner, source] of [['z-owner', 'cli'], ['a-owner', 'tui']]) {
        meta.run(`gateway.local_policy.v1:${owner}`, JSON.stringify({ session_id: owner, entry: { session_id: 'pruned-alias' }, lineage: ['pruned-alias'], policy: { source } }))
      }
    } finally { db.close() }
    const padding = Array.from({ length: 133 }, (_, i) => `padding-${String(i)}`)
    const result = stateDbSessionSources(path, ['z-owner', ...padding, 'a-owner', 'pruned-alias'])
    expect(result?.get('pruned-alias')).toEqual({ source: 'cli', canonical: true, execution_mode: 'normal' })
  })

  it.each([
    ['target', '[1]', true], ['other', '{broken', true],
    ['other', '["target", 1]', true], ['other', '{"segment":"target"}', true],
    ['other', '"target"', true], ['other', '[1]', false],
    ['other', '{"segment":"unrelated"}', false],
  ] as const)('preserves the ownership fence for ledger %s with %s', (owner, lineage, unreadable) => {
    const db = new DatabaseSync(path)
    try {
      db.exec('CREATE TABLE session_admissions (target_session_id TEXT, lineage_json TEXT)')
      db.prepare('INSERT INTO session_admissions VALUES (?, ?)').run(owner, lineage)
    } finally { db.close() }
    const result = stateDbSessionSources(path, ['target', '1'])
    expect(result).toEqual(unreadable ? null : new Map())
  })

  it('keeps direct ledger ownership on schemas without lineage_json', () => {
    const db = new DatabaseSync(path)
    try {
      db.exec("CREATE TABLE session_admissions (target_session_id TEXT); INSERT INTO session_admissions VALUES ('pruned')")
    } finally { db.close() }
    expect(stateDbSessionSources(path, ['pruned'])).toEqual(new Map([['pruned', { source: '', canonical: true }]]))
  })
})
