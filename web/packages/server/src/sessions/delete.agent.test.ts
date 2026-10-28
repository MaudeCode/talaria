import { sessionPath } from '../test/storage.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session.js'
import { SidecarClient } from '../sidecar/client.js'
import { bootTestServer, type TestServer, openStateDb } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import type { StateDbWorkerRequest } from './state-db.js'

describe('request-scoped session gate reads', () => {
  let server: TestServer | null = null
  afterEach(async () => { vi.restoreAllMocks(); await server?.close(); server = null })

  beforeEach(async () => {
    const sidecar = new FakeSidecar()
    server = await bootTestServer({ sidecar })
    const db = openStateDb(join(server.state, 'state.db'))
    try {
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, parent_session_id TEXT, ended_at REAL, end_reason TEXT, title TEXT, model TEXT, message_count INTEGER);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)`)
      for (let i = 0; i < 3; i += 1) {
        db.prepare('INSERT INTO sessions (id, source, started_at, parent_session_id, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?)').run(`cli-${i}`, 'cli', i * 10, i ? `cli-${i - 1}` : null, i < 2 ? (i + 1) * 10 : null, i < 2 ? 'compression' : null)
        db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(i, `cli-${i}`, 'user', `segment ${i}`, i * 10 + 1)
      }
    } finally { db.close() }
  })

  it('reads each CLI compression-chain gate once before the fresh write-boundary checks', async () => {
    const sidecar = server!.deps.sessions.deps.sidecar!() as FakeSidecar
    // Defeat the separate sidebar cache so it cannot hide repeated service lookups.
    const service = server!.deps.sessions
    const cliSessions = service.deps.cliSessions
    vi.spyOn(service.deps, 'cliSessions').mockImplementation((...args) => { server!.deps.cliSessions.invalidate(); return cliSessions(...args) })
    const calls = vi.spyOn(Worker.prototype, 'postMessage')
    const requests = (): StateDbWorkerRequest[] => calls.mock.calls.map(([request]) => request as StateDbWorkerRequest)
    let preliminary: StateDbWorkerRequest[] = []
    const withLock = server!.deps.sessionStore.withLock.bind(server!.deps.sessionStore)
    vi.spyOn(server!.deps.sessionStore, 'withLock').mockImplementation((...args) => { preliminary = requests(); return withLock(...args) })
    sidecar.respond('state_db.delete_cli_session', () => ({ ok: true, deleted_ids: ['cli-0', 'cli-1', 'cli-2'] }))
    expect(await service.delete('cli-2')).toMatchObject({ ok: true, state_db_cleanup_failed: false })
    expect(preliminary.length).toBeGreaterThan(0)
    const key = (r: StateDbWorkerRequest): string => r.op === 'session' ? `${r.op}:${r.read}:${JSON.stringify(r.args)}` : r.op
    for (const kind of new Set(preliminary.map(key))) {
      expect(preliminary.filter((r) => key(r) === kind), kind).toHaveLength(1)
    }
    // Fresh checks at the lock, delete dispatch and each of the three Agent evictions stay outside the memo.
    expect(requests().filter((r) => r.op === 'sources')).toHaveLength(6)
    expect(sidecar.calls.filter((c) => c.method === 'state_db.delete_cli_session')).toHaveLength(1)
  })

  it.each(['rename', 'archive', 'pin'] as const)('shares %s admission reads and checks the next request afresh', async (action) => {
    const service = server!.deps.sessions
    const calls = vi.spyOn(Worker.prototype, 'postMessage')
    let preliminary: StateDbWorkerRequest[] = []
    const withLock = server!.deps.sessionStore.withLock.bind(server!.deps.sessionStore)
    vi.spyOn(server!.deps.sessionStore, 'withLock').mockImplementation((...args) => {
      preliminary = calls.mock.calls.map(([r]) => r as StateDbWorkerRequest)
      return withLock(...args)
    })
    if (action === 'rename') await service.rename('cli-2', 'Renamed CLI')
    else await service[action]('cli-2', true)
    expect(preliminary.filter((r) => r.op === 'sources')).toHaveLength(1)
    expect(preliminary.filter((r) => r.op === 'rowBatches')).toHaveLength(1)
    const db = openStateDb(join(server!.state, 'state.db'))
    try { db.exec("UPDATE sessions SET source = 'subagent' WHERE id = 'cli-2'") } finally { db.close() }
    await expect(service.archive('cli-2', false)).rejects.toMatchObject({ status: 400 })
  })

  it('shares owner and existence reads when refusing a retained read-only import', async () => {
    await server!.deps.sessionStore.save(new Session({ session_id: 'cli-2', source_tag: 'cli', read_only: true }, { workspace: server!.state, model: null }))
    const calls = vi.spyOn(Worker.prototype, 'postMessage')
    await expect(server!.deps.sessions.delete('cli-2')).rejects.toMatchObject({ status: 400 })
    const requests = calls.mock.calls.map(([r]) => r as StateDbWorkerRequest)
    expect(requests.filter((r) => r.op === 'sources')).toHaveLength(1)
    expect(requests.filter((r) => r.op === 'existing')).toHaveLength(1)
  })
})

// Like env-write.agent.test.ts, exercise HTTP with the real sidecar and disposable Agent state.
const agentDir = process.env.HERMES_WEBUI_AGENT_DIR ?? ''
const python = process.env.HERMES_WEBUI_PYTHON ?? join(agentDir, '.venv/bin/python')
const ledgerAvailable = Boolean(agentDir) && existsSync(join(agentDir, 'hermes_state_mutation_retirement.py')) && existsSync(python)

describe.skipIf(!ledgerAvailable)('session deletion against the runtime-ledger Agent (TAL-1034, TAL-1036)', () => {
  let s: TestServer | null = null
  let client: SidecarClient | null = null
  let home = ''
  afterEach(async () => { await s?.close(); await client?.close(); if (home) rmSync(home, { recursive: true, force: true }); s = null; client = null })

  it.each([false, true])('respects canonical ownership when deleting a native chat (ledger=%s)', async (ledger) => {
    home = mkdtempSync(join(tmpdir(), 'talaria-ledger-delete-'))
    const seed = spawnSync(python, ['-c', `
import sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from hermes_state import SessionDB
import hermes_state_runtime as rt
with SessionDB(Path(sys.argv[2]) / 'state.db') as db:
    db.create_session('cli-settled', source='cli')
    db.append_message('cli-settled', 'user', 'retirement regression')
    if sys.argv[3] == 'true':
        epoch = rt.begin_runtime_epoch(db, instance_id='fixture')
        admitted = rt.admit_session_input(db, epoch=epoch, principal_id='human', session_id='cli-settled', request_id='once', payload={'text': 'retirement regression'})
        claim = rt.claim_session_input(db, epoch=epoch, session_id='cli-settled')
        rt.settle_session_input(db, epoch=epoch, admission_id=admitted['admission_id'], generation=claim['generation'], outcome='completed')
`, agentDir, home, String(ledger)], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home, HERMES_STATE_DB_GUARD_BYPASS: '1' } })
    expect(seed.status, seed.stderr).toBe(0)
    client = new SidecarClient({ python, agentDir, sidecarDir: resolve(import.meta.dirname, '../../../../sidecar'), hermesHome: home, log: () => undefined })
    await client.start()
    s = await bootTestServer({ sidecar: client, env: { HERMES_HOME: home, HERMES_WEBUI_STATE_DIR: join(home, 'webui') } })
    await s.deps.sessionStore.save(new Session({ session_id: 'cli-settled', source_tag: 'webui', messages: [{ role: 'user', content: 'retirement regression' }] }, { workspace: home, model: null }))
    await s.deps.settings.save({ show_cli_sessions: true })
    const savedPath = sessionPath(s.deps.sessionStore, 'cli-settled')
    const before = readFileSync(savedPath, 'utf8')
    const calls = vi.spyOn(client, 'call')
    const response = await s.get('/api/session/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'cli-settled' }) })
    const result: unknown = await response.json()
    if (ledger) {
      expect(response.status).toBe(403)
      expect(readFileSync(savedPath, 'utf8')).toBe(before)
      expect(calls.mock.calls.filter(([method]) => method === 'state_db.delete_cli_session')).toEqual([])
      const db = new DatabaseSync(join(home, 'state.db'), { readOnly: true })
      try {
        expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'cli-settled' }])
        expect(db.prepare('SELECT content FROM messages').all()).toEqual([{ content: 'retirement regression' }])
        expect(db.prepare('SELECT status FROM session_admissions').all()).toEqual([{ status: 'terminal' }])
      } finally { db.close() }
      return
    }
    expect(response.status).toBe(200)
    expect(existsSync(sessionPath(s.deps.sessionStore, 'cli-settled'))).toBe(false)
    s.deps.cliSessions.invalidate()
    const listed = await (await s.get('/api/sessions')).json() as { sessions: { session_id: string }[] }
    expect(listed.sessions.map((session) => session.session_id)).not.toContain('cli-settled')
    expect(result).toEqual({ ok: true, state_db_cleanup_failed: false })
  })
})
