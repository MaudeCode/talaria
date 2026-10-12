import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

const HASH = 'd7ead930c1f2b3a4d5e6f708192a3b4c5d6e7f80'
const STORE = '/home/.hermes/checkpoints/store'
/** `git diff <checkpoint> --cached` in the Agent's store: `a/` is the checkpoint, `b/` the workspace now. */
const DIFF = [
  'diff --git a/docs/a.txt b/docs/a.txt', 'index 1234567..89abcde 100644', '--- a/docs/a.txt', '+++ b/docs/a.txt', '@@ -1,2 +1 @@', ' alpha', '-gamma',
  'diff --git a/new.txt b/new.txt', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+fresh',
  'diff --git a/removed.txt b/removed.txt', 'deleted file mode 100644', 'index 2222222..0000000', '--- a/removed.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone',
  'diff --git a/old name.txt b/moved.txt', 'similarity index 100%', 'rename from old name.txt', 'rename to moved.txt',
  'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"', 'index 3333333..4444444 100644', '--- "a/caf\\303\\251.txt"', '+++ "b/caf\\303\\251.txt"', '@@ -1 +1 @@', '-a', '+b',
  'diff --git a/logo.png b/logo.png', 'index 5555555..6666666 100644', 'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n')

describe('workspace checkpoints through the Agent (TAL-913)', () => {
  let s: TestServer
  let ws: string
  const sidecar = new FakeSidecar()
  beforeAll(async () => {
    s = await bootTestServer({ sidecar })
    ws = realpathSync(join(s.state, 'workspace'))
  })
  afterAll(async () => { await s.close() })
  beforeEach(() => {
    sidecar.calls.length = 0
    sidecar.respond('checkpoints.list', () => ({ checkpoints: [{ hash: HASH, short_hash: 'd7ead93', timestamp: '2026-10-12T09:30:15+02:00', reason: 'before write_file', files_changed: 3, insertions: 2, deletions: 1 }], store: STORE }))
    sidecar.respond('checkpoints.diff', () => ({ stat: '', diff: DIFF }))
    sidecar.respond('checkpoints.restore', () => ({ restored_to: HASH.slice(0, 8), reason: 'before write_file' }))
  })

  it('lists the checkpoints the Agent keeps for a configured workspace', async () => {
    const res = await s.get(`/api/rollback/list?workspace=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      checkpoints: [{ id: HASH, commit: 'd7ead93', message: 'before write_file', date: '2026-10-12T09:30:15+02:00', date_display: '2026-10-12 09:30', files: 3, path: STORE }],
      workspace: ws,
      checkpoint_dir: STORE,
    })
    expect(sidecar.calls).toEqual([{ method: 'checkpoints.list', params: { profile_home: expect.any(String) as unknown, workspace: ws } }])
  })

  it('diffs a checkpoint against the workspace and names every changed file', async () => {
    const res = await s.get(`/api/rollback/diff?workspace=${encodeURIComponent(ws)}&id=${HASH}`)
    expect(res.status).toBe(200)
    const diff = await json(res)
    expect(diff.files_changed).toEqual([
      { file: 'docs/a.txt', status: 'modified' }, { file: 'new.txt', status: 'added' }, { file: 'removed.txt', status: 'deleted' },
      { file: 'old name.txt', status: 'deleted' }, { file: 'moved.txt', status: 'added' }, { file: 'café.txt', status: 'modified' }, { file: 'logo.png', status: 'modified' },
    ])
    expect(diff).toMatchObject({ checkpoint: HASH, workspace: ws, diff: DIFF.trimEnd(), total_changes: 7 })
    expect(sidecar.calls.at(-1)).toEqual({ method: 'checkpoints.diff', params: { profile_home: expect.any(String) as unknown, workspace: ws, checkpoint: HASH } })
  })

  it('restores through the Agent and reports the files the checkpoint rewrote', async () => {
    const res = await post(s, '/api/rollback/restore', { workspace: ws, checkpoint: HASH })
    expect(res.status).toBe(200)
    // A file added since the checkpoint is not in it, so a restore leaves it alone.
    expect(await json(res)).toEqual({ ok: true, checkpoint: HASH, workspace: ws, files_restored: ['docs/a.txt', 'removed.txt', 'old name.txt', 'café.txt', 'logo.png'], files_restored_count: 5, errors: [] })
    expect(sidecar.calls.map((c) => c.method)).toEqual(['checkpoints.diff', 'checkpoints.restore'])
    expect(sidecar.calls.at(-1)?.params).toEqual({ profile_home: expect.any(String) as unknown, workspace: ws, checkpoint: HASH })
  })

  it("answers the Agent's refusal as a 400 and an unavailable sidecar as a 503", async () => {
    const refusal = 'Checkpoint contains nested git repositories that were not captured (vendor); rollback was not performed'
    sidecar.respond('checkpoints.restore', () => { throw new SidecarError(refusal, { condition: 'checkpoint_failed' }) })
    let res = await post(s, '/api/rollback/restore', { workspace: ws, checkpoint: HASH })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ error: refusal })
    sidecar.respond('checkpoints.list', () => { throw new SidecarError('sidecar not ready (starting)', { condition: 'sidecar_unavailable' }) })
    res = await s.get(`/api/rollback/list?workspace=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(503)
  })

  it('refuses a diff or restore while a run is active in the workspace, since its checkpoint capture shares the store', async () => {
    s.deps.registry.activeRuns.set('ckpt-run', { stream_id: 'ckpt-run', session_id: 'other', started_at: 0, phase: 'running', workspace: join(ws, 'sub'), model: null, provider: null, ephemeral: false })
    try {
      let res = await s.get(`/api/rollback/diff?workspace=${encodeURIComponent(ws)}&checkpoint=${HASH}`)
      expect({ status: res.status, body: await json(res) }).toMatchObject({ status: 409, body: { code: 'active_stream' } })
      res = await post(s, '/api/rollback/restore', { workspace: ws, checkpoint: HASH })
      expect({ status: res.status, body: await json(res) }).toMatchObject({ status: 409, body: { code: 'active_stream' } })
      expect(sidecar.calls).toEqual([])
      // Listing reads only the Agent's log, so it still answers during a run.
      expect((await s.get(`/api/rollback/list?workspace=${encodeURIComponent(ws)}`)).status).toBe(200)
    } finally {
      s.deps.registry.activeRuns.delete('ckpt-run')
    }
  })

  it('refuses a checkpoint id or workspace it cannot vouch for before asking the Agent', async () => {
    expect((await s.get(`/api/rollback/diff?workspace=${encodeURIComponent(ws)}&checkpoint=../abc123`)).status).toBe(400)
    expect((await s.get(`/api/rollback/list?workspace=${encodeURIComponent(s.state)}`)).status).toBe(400)
    expect((await s.get('/api/rollback/list')).status).toBe(400)
    expect(sidecar.calls).toEqual([])
  })

  it('serves checkpoints for a session whose workspace is not a configured one (TAL-571)', async () => {
    // A worktree-backed chat works in a generated directory that is not in the configured workspace list.
    const wt = join(s.state, 'tal571-worktree')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, 'notes.txt'), 'edited\n')
    const created = await json(await post(s, '/api/session/new', { workspace: ws }))
    const wsid = String((created.session as Json).session_id)
    const session = s.deps.sessionStore.get(wsid)
    session.workspace = wt
    s.deps.sessionStore.save(session)
    // By path alone the worktree is still refused; the session vouches for its own workspace and nothing else.
    expect((await s.get(`/api/rollback/list?workspace=${encodeURIComponent(wt)}`)).status).toBe(400)
    const res = await s.get(`/api/rollback/list?session_id=${wsid}`)
    expect(res.status).toBe(200)
    expect((await json(res)).workspace).toBe(realpathSync(wt))
    expect((await post(s, '/api/rollback/restore', { session_id: wsid, checkpoint: HASH })).status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method.startsWith('checkpoints.')).map((c) => (c.params as Json).workspace)).toEqual([realpathSync(wt), realpathSync(wt), realpathSync(wt)])
    expect((await s.get('/api/rollback/list?session_id=missing-session')).status).toBe(404)
  })
})
