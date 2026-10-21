import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRowsExisting, cheapChangeFingerprint, countConversationRounds, insightsSessionRows, latestCronSessionInfo, readImportableAgentSessionRows, stateDbCompressionLineage, stateDbCronJobIds, stateDbHasSession, stateDbLineageReport, stateDbLocalTarget, stateDbSessionRow, stateDbSessionSources, stateDbSessionRead, stateDbStorage, stateDbTailToolContent, stateDbWebDiagnosticIds, stopStateDbWorker } from './state-db.js'

const observed = vi.hoisted(() => ({ handles: [] as import('node:sqlite').DatabaseSync[], probes: [] as string[] }))
vi.mock('node:sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:sqlite')>()
  class ObservedDatabase extends real.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof real.DatabaseSync>) {
      super(...args)
      if (args[1]?.readOnly) observed.handles.push(this)
    }
    override prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
      if (/PRAGMA (table_info|index_list)/i.test(sql)) observed.probes.push(sql)
      return super.prepare(sql)
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

  it('closes direct-reader handles at shutdown and can reopen afterward', async () => {
    readImportableAgentSessionRows(path)
    const db = observed.handles[0]!
    expect(db.isOpen).toBe(true)
    await stopStateDbWorker()
    expect(db.isOpen).toBe(false)
    readImportableAgentSessionRows(path)
    expect(observed.handles.length).toBe(2)
  })
})
