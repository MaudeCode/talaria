/**
 * Worktree session regressions.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { allSessions } from '../sessions/list.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

/** A clone with an upstream plus one linked worktree, the shape `worktree_status_for_session` was written against. */
function gitFixture(root: string): { repo: string; worktree: string } {
  const upstream = join(root, 'upstream.git')
  mkdirSync(upstream, { recursive: true })
  git(upstream, 'init', '--bare', '--quiet', '-b', 'main')
  const repo = join(root, 'repo')
  git(root, 'clone', '--quiet', upstream, repo)
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'init')
  git(repo, 'push', '--quiet', '-u', 'origin', 'main')
  const worktree = join(root, 'wt')
  git(repo, 'worktree', 'add', '--quiet', '-b', 'hermes/wt', worktree)
  git(worktree, 'push', '--quiet', '-u', 'origin', 'hermes/wt')
  return { repo, worktree }
}

describe('worktree-backed sessions', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let ws: string
  let configs: Map<string, Json>
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    configs = new Map()
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
    sidecar.respond('worktree.create', (params) => {
      if (!existsSync(join(params.repo_root, '.git'))) throw new SidecarError(`${params.repo_root} is not inside a git repository`, { condition: 'not_a_repo' })
      const path = join(params.repo_root, '.worktrees', 'hermes-wt')
      mkdirSync(path, { recursive: true })
      return { path, branch: 'hermes/wt', repo_root: params.repo_root, base: null }
    })
    s = await bootTestServer({ sidecar })
    ws = realpathSync(join(s.state, 'workspace'))
    mkdirSync(join(ws, '.git'), { recursive: true })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
  })
  afterAll(() => s.close())
  const setConfig = (cfg: Json): void => { configs.set(s.state, cfg); s.deps.agentConfig.invalidate() }

  it('session/new with worktree:true answers the worktree as the workspace', async () => {
    const res = await post(s, '/api/session/new', { workspace: ws, worktree: true, profile: 'default' })
    expect(res.status).toBe(200)
    const session = (await json(res)).session as Json
    expect(session.worktree_path).toBe(join(ws, '.worktrees', 'hermes-wt'))
    expect(session.workspace).toBe(session.worktree_path)
    expect(session.worktree_branch).toBe('hermes/wt')
  })

  it('the four worktree keys persist in the session file and reload through the API', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const sid = String(created.session_id)
    const raw = JSON.parse(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')) as Json
    expect(raw).toMatchObject({ worktree_path: created.worktree_path, worktree_branch: 'hermes/wt', worktree_repo_root: ws })
    expect(typeof raw.worktree_created_at).toBe('number')
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect(detail).toMatchObject({ worktree_path: created.worktree_path, worktree_branch: 'hermes/wt', worktree_repo_root: ws })
  })

  it('a worktree session is written at creation, not on first message', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    expect(existsSync(join(s.state, 'sessions', `${String(created.session_id)}.json`))).toBe(true)
    const plain = (await json(await post(s, '/api/session/new', { workspace: ws }))).session as Json
    expect(existsSync(join(s.state, 'sessions', `${String(plain.session_id)}.json`))).toBe(false)
  })

  it('the sidebar index keeps a zero-message worktree session', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const plain = (await json(await post(s, '/api/session/new', { workspace: ws }))).session as Json
    // Python `all_sessions()`: the empty-draft filter exempts worktree-backed sessions (the HTTP list additionally applies visible_only in both backends).
    const ids = allSessions(s.deps.sessionStore).map((r) => r.session_id)
    expect(ids).toContain(created.session_id)
    expect(ids).not.toContain(plain.session_id)
  })

  it('worktree:true without a workspace falls back to the last workspace', async () => {
    await post(s, '/api/session/new', { workspace: ws })
    const res = await post(s, '/api/session/new', { worktree: true })
    expect(res.status).toBe(200)
    const session = (await json(res)).session as Json
    expect(session.worktree_repo_root).toBe(ws)
    expect(session.workspace).toBe(join(ws, '.worktrees', 'hermes-wt'))
  })

  it('no worktree key and config off is a plain session without worktree_skipped', async () => {
    setConfig({})
    const body = await json(await post(s, '/api/session/new', { workspace: ws, profile: 'default' }))
    expect((body.session as Json).worktree_path ?? null).toBeNull()
    expect('worktree_skipped' in body).toBe(false)
  })

  it('config worktree:true creates a worktree when the key is absent', async () => {
    setConfig({ worktree: true })
    const session = (await json(await post(s, '/api/session/new', { workspace: ws, profile: 'default' }))).session as Json
    expect(session.worktree_path).toBe(join(ws, '.worktrees', 'hermes-wt'))
    expect(session.workspace).toBe(session.worktree_path)
    expect(session.worktree_branch).toBe('hermes/wt')
  })

  it('worktree:false wins over the config default', async () => {
    setConfig({ worktree: true })
    const before = sidecar.calls.filter((c) => c.method === 'worktree.create').length
    const session = (await json(await post(s, '/api/session/new', { workspace: ws, profile: 'default', worktree: false }))).session as Json
    expect(session.worktree_path ?? null).toBeNull()
    expect(sidecar.calls.filter((c) => c.method === 'worktree.create').length).toBe(before)
  })

  it('sending worktree:null is explicit and never falls through to the config', async () => {
    setConfig({ worktree: true })
    const session = (await json(await post(s, '/api/session/new', { workspace: ws, profile: 'default', worktree: null }))).session as Json
    expect(session.worktree_path ?? null).toBeNull()
  })

  it('worktree:true wins over a config default of off', async () => {
    setConfig({ worktree: false })
    const session = (await json(await post(s, '/api/session/new', { workspace: ws, profile: 'default', worktree: true }))).session as Json
    expect(session.worktree_path).toBe(join(ws, '.worktrees', 'hermes-wt'))
  })

  it('the config default degrades to a plain session with worktree_skipped outside git', async () => {
    setConfig({ worktree: true })
    const plainDir = join(ws, 'plain-ws')
    mkdirSync(plainDir, { recursive: true })
    const body = await json(await post(s, '/api/session/new', { workspace: plainDir, profile: 'default' }))
    expect((body.session as Json).worktree_path ?? null).toBeNull()
    expect(String(body.worktree_skipped)).toContain('not inside a git repository')
  })

  it('an explicit worktree request outside git is a hard 400', async () => {
    setConfig({})
    const plainDir = join(ws, 'plain-ws2')
    mkdirSync(plainDir, { recursive: true })
    const res = await post(s, '/api/session/new', { workspace: plainDir, worktree: true })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toContain('not inside a git repository')
  })

  it('a remote-terminal profile skips the host worktree and reports worktree_skipped', async () => {
    setConfig({ worktree: true, terminal: { backend: 'remote', cwd: ws } })
    const res = await post(s, '/api/session/new', { workspace: ws, profile: 'default' })
    const body = await json(res)
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect((body.session as Json).worktree_path ?? null).toBeNull()
    expect(body.worktree_skipped).toBeTruthy()
    setConfig({})
  })

  it('an explicit worktree on a remote-terminal profile answers 400 remote_workspace_unsupported', async () => {
    setConfig({ terminal: { backend: 'remote', cwd: ws } })
    const before = sidecar.calls.filter((c) => c.method === 'worktree.create').length
    const res = await post(s, '/api/session/new', { workspace: ws, profile: 'default', worktree: true })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('remote_workspace_unsupported')
    expect(sidecar.calls.filter((c) => c.method === 'worktree.create').length).toBe(before)
    setConfig({})
  })

  it('deleting a worktree session keeps the worktree and reports it', async () => {
    setConfig({})
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const sid = String(created.session_id)
    const res = await post(s, '/api/session/delete', { session_id: sid })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body, JSON.stringify(body)).toMatchObject({ ok: true, state_db_cleanup_failed: false, worktree_retained: true, worktree_path: created.worktree_path, worktree_branch: 'hermes/wt' })
    expect(existsSync(join(s.state, 'sessions', `${sid}.json`))).toBe(false)
    expect(existsSync(String(created.worktree_path))).toBe(true)
  })

  it('archiving a worktree session keeps the worktree and reports it', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const res = await post(s, '/api/session/archive', { session_id: created.session_id, archived: true })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toMatchObject({ ok: true, worktree_retained: true, worktree_path: created.worktree_path })
    expect((body.session as Json).archived).toBe(true)
    expect(existsSync(String(created.worktree_path))).toBe(true)
  })

  it('delete answers 409 while a run is live and leaves the files alone', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const sid = String(created.session_id)
    s.deps.registry.registerActiveRun({ stream_id: 'live-run-1', session_id: sid, phase: 'cancelling', started_at: Date.now() / 1000 } as never)
    try {
      const res = await post(s, '/api/session/delete', { session_id: sid })
      expect(res.status).toBe(409)
      expect(String((await json(res)).error)).toContain('active run')
      expect(existsSync(join(s.state, 'sessions', `${sid}.json`))).toBe(true)
      expect(readFileSync(join(s.state, 'sessions', '_index.json'), 'utf8')).toContain(sid)
    } finally {
      s.deps.registry.activeRuns.delete('live-run-1')
    }
    expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
  })

  it('an unlink failure answers 500 and prunes nothing', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const sid = String(created.session_id)
    const dir = join(s.state, 'sessions')
    chmodSync(dir, 0o500)
    try {
      const res = await post(s, '/api/session/delete', { session_id: sid })
      expect(res.status).toBe(500)
      expect(await json(res)).toEqual({ error: 'Failed to delete session data' })
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(existsSync(join(s.state, 'sessions', `${sid}.json`))).toBe(true)
    expect(readFileSync(join(s.state, 'sessions', '_index.json'), 'utf8')).toContain(sid)
    expect((await s.get(`/api/session?session_id=${sid}`)).status).toBe(200)
  })
})

describe('worktree status against a real git worktree', () => {
  let s: TestServer
  let repo = ''
  let worktree = ''
  let sid = ''
  beforeAll(async () => {
    s = await bootTestServer()
    const fixture = gitFixture(join(realpathSync(join(s.state, 'workspace')), 'git'))
    repo = fixture.repo
    worktree = fixture.worktree
    sid = String(((await json(await post(s, '/api/session/new', { workspace: repo }))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.worktree_path = worktree
    session.worktree_repo_root = repo
    session.worktree_branch = 'hermes/wt'
    s.deps.sessionStore.save(session)
  })
  afterAll(() => s.close())
  const status = async (): Promise<Json> => (await json(await s.get(`/api/session/worktree/status?session_id=${sid}`))).status as Json

  it('a clean listed worktree with an upstream reports zero ahead/behind', async () => {
    expect(await status()).toMatchObject({ path: worktree, exists: true, listed: true, dirty: false, untracked_count: 0, ahead_behind: { available: true, ahead: 0, behind: 0 }, locked_by_stream: false, locked_by_terminal: false })
  })

  it('edits, untracked files, and local commits show as dirty, untracked, and ahead', async () => {
    writeFileSync(join(worktree, 'README.md'), 'changed\n')
    writeFileSync(join(worktree, 'new.txt'), 'new\n')
    expect(await status()).toMatchObject({ dirty: true, untracked_count: 1, ahead_behind: { available: true, ahead: 0 } })
    git(worktree, 'commit', '--quiet', '-am', 'edit')
    expect(await status()).toMatchObject({ dirty: true, untracked_count: 1, ahead_behind: { available: true, ahead: 1, behind: 0 } })
  })

  it('locked_by_stream follows the live stream registry', async () => {
    const session = s.deps.sessionStore.get(sid)
    session.active_stream_id = 'stream-live'
    s.deps.sessionStore.save(session)
    s.deps.registry.liveIds.add('stream-live')
    expect((await status()).locked_by_stream).toBe(true)
    s.deps.registry.liveIds.delete('stream-live')
    expect((await status()).locked_by_stream).toBe(false)
  })
})
