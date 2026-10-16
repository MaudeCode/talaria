import { sessionPath } from '../test/storage.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session.js'
import { SidecarClient } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

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
