import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { cleanGeneratedCommitMessage, classifyGitError, GitRunner } from './git.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null' } })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout
}

async function repoSession(s: TestServer): Promise<{ sid: string; ws: string }> {
  const ws = realpathSync(join(s.state, 'workspace'))
  const res = await post(s, '/api/session/new', { workspace: ws })
  expect(res.status).toBe(200)
  const sid = String(((await json(res)).session as Json).session_id)
  return { sid, ws }
}

describe('workspace git over HTTP', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await bootTestServer({ env: { HERMES_WEBUI_WORKSPACE_GIT_DESTRUCTIVE: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
    const ws = join(s.state, 'workspace')
    git(ws, 'init', '-q', '-b', 'main')
    writeFileSync(join(ws, 'README.md'), 'hello\n')
    git(ws, 'add', '.')
    git(ws, 'commit', '-q', '-m', 'init')
  })
  afterAll(() => s.close())

  it('reports git-info and status for a clean repo, then tracks edits', async () => {
    const { sid, ws } = await repoSession(s)
    let res = await s.get(`/api/git-info?session_id=${sid}`)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ git: { branch: 'main', dirty: 0, modified: 0, untracked: 0, ahead: 0, behind: 0, is_git: true } })

    writeFileSync(join(ws, 'README.md'), 'hello\nworld\n')
    writeFileSync(join(ws, 'new.txt'), 'fresh\n')
    // Polled reads reuse the payload for 2 s when .git is untouched (Python STATUS_CACHE_TTL); a mutation would invalidate it.
    s.deps.git.invalidateStatusCache(ws)
    res = await s.get(`/api/git/status?session_id=${sid}`)
    expect(res.status).toBe(200)
    const status = (await json(res)).git as Json
    expect(status.is_git).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.totals).toEqual({ changed: 2, staged: 0, unstaged: 1, untracked: 1, conflicts: 0 })
    const files = status.files as Json[]
    expect(files.map((f) => f.path)).toEqual(['new.txt', 'README.md'])
    expect(files[0]).toMatchObject({ status: '??', untracked: true, additions: 1, deletions: 0 })
    expect(files[1]).toMatchObject({ status: 'M', unstaged: true, staged: false, additions: 1, deletions: 0 })

    res = await s.get(`/api/git/diff?session_id=${sid}&path=README.md`)
    expect(res.status).toBe(200)
    const diff = (await json(res)).diff as Json
    expect(diff.diff).toContain('+world')
    expect(diff).toMatchObject({ path: 'README.md', kind: 'unstaged', additions: 1, deletions: 0, binary: false })
    const untracked = (await json(await s.get(`/api/git/diff?session_id=${sid}&path=new.txt`))).diff as Json
    expect(untracked.diff).toBe('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+fresh\n')
    expect((await s.get(`/api/git/diff?session_id=${sid}&path=../outside`)).status).toBe(400)
  })

  it('an untracked entry that is a symlink out of the workspace is never read for the synthetic diff or the counts', async () => {
    const { sid, ws } = await repoSession(s)
    writeFileSync(join(s.state, 'secret.env'), 'TOKEN=leak\n')
    symlinkSync(join(s.state, 'secret.env'), join(ws, 'linked.txt'))
    // The status cache is keyed on the index/HEAD fingerprint (Python parity); a new untracked entry needs a fresh scan.
    ;(s.deps.git as unknown as { statusCache: Map<string, unknown> }).statusCache.clear()
    const status = (await json(await s.get(`/api/git/status?session_id=${sid}`))).git as Json
    const row = (status.files as Json[]).find((f) => f.path === 'linked.txt')
    expect(row, JSON.stringify(status)).toMatchObject({ untracked: true, additions: 0 })
    const linked = await s.get(`/api/git/diff?session_id=${sid}&path=linked.txt`)
    expect(await linked.text()).not.toContain('TOKEN=leak')
    rmSync(join(ws, 'linked.txt'))
  })

  it('stages, commits selected files, discards, and lists branches', async () => {
    const { sid, ws } = await repoSession(s)
    let res = await post(s, '/api/git/stage', { session_id: sid, paths: ['README.md'] })
    expect(res.status).toBe(200)
    expect(((await json(res)).git as Json).totals).toMatchObject({ staged: 1, unstaged: 0, untracked: 1 })
    res = await post(s, '/api/git/unstage', { session_id: sid, path: 'README.md' })
    expect(res.status).toBe(200)
    expect(((await json(res)).git as Json).totals).toMatchObject({ staged: 0, unstaged: 1 })

    res = await post(s, '/api/git/commit-selected', { session_id: sid, message: 'add new file', paths: ['new.txt'] })
    expect(res.status).toBe(200)
    const committed = await json(res)
    expect(committed.paths).toEqual(['new.txt'])
    expect(String(committed.commit)).toMatch(/^[0-9a-f]{7,}$/)
    expect((committed.status as Json).totals).toMatchObject({ changed: 1, unstaged: 1, untracked: 0 })
    expect(git(ws, 'log', '--format=%s', '-1').trim()).toBe('add new file')

    res = await post(s, '/api/git/discard', { session_id: sid, paths: ['README.md'] })
    expect(res.status).toBe(200)
    expect(((await json(res)).git as Json).totals).toMatchObject({ changed: 0 })

    res = await s.get(`/api/git/branches?session_id=${sid}`)
    expect(res.status).toBe(200)
    const branches = (await json(res)).branches as Json
    expect(branches.current).toBe('main')
    expect((branches.local as Json[]).map((b) => b.name)).toEqual(['main'])

    res = await post(s, '/api/git/checkout', { session_id: sid, ref: 'feature', mode: 'new' })
    expect(res.status).toBe(200)
    expect((await json(res)).current_branch).toBe('feature')
    res = await post(s, '/api/git/checkout', { session_id: sid, ref: 'main', mode: 'local' })
    expect(res.status).toBe(200)
    res = await post(s, '/api/git/checkout', { session_id: sid, ref: 'nope', mode: 'local' })
    expect(res.status).toBe(400)
    expect((await json(res)).code).toBe('invalid_ref')

    res = await post(s, '/api/git/push', { session_id: sid })
    expect(res.status).toBe(400)
    expect((await json(res)).code).toBe('no_upstream')
    res = await post(s, '/api/git/commit-message', { session_id: sid })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Stage changes before generating a commit message')
  })

  it('answers is_git=false outside a repository and 404 for unknown sessions', async () => {
    const outside = join(s.state, 'plain')
    mkdirSync(outside)
    expect((await post(s, '/api/workspaces/add', { path: outside })).status).toBe(200)
    const res = await post(s, '/api/session/new', { workspace: outside })
    const sid = String(((await json(res)).session as Json).session_id)
    expect(await json(await s.get(`/api/git/status?session_id=${sid}`))).toEqual({ git: { is_git: false } })
    expect(await json(await s.get(`/api/git-info?session_id=${sid}`))).toEqual({ git: null })
    const branches = await s.get(`/api/git/branches?session_id=${sid}`)
    expect(branches.status).toBe(400)
    expect((await json(branches)).code).toBe('not_a_repo')
    expect((await s.get('/api/git/status?session_id=deadbeef0000')).status).toBe(404)
    expect((await s.get('/api/git/status')).status).toBe(400)
  })

  it('parity: vanished untracked discard, missing workspace, single-line hunk header, in-repo untracked symlink, checkout inputs', async () => {
    const { sid, ws } = await repoSession(s)
    const gitRunner = s.deps.git as unknown as { statusCache: Map<string, unknown> }
    // An untracked file removed between status and unlink is a benign race (Python `unlink(missing_ok=True)` semantics).
    // The anchored unlink enters the workspace with chdir on macOS; the file vanishes right there.
    writeFileSync(join(ws, 'transient.txt'), 'x\n')
    gitRunner.statusCache.clear()
    let res: Response
    if (process.platform !== 'linux') {
      const realChdir = process.chdir.bind(process)
      let raced = false
      const spy = vi.spyOn(process, 'chdir').mockImplementation((dir: string) => {
        realChdir(dir)
        if (!raced && dir === realpathSync(ws) && existsSync(join(ws, 'transient.txt'))) { raced = true; rmSync(join(ws, 'transient.txt')) }
      })
      try {
        res = await post(s, '/api/git/discard', { session_id: sid, paths: ['transient.txt'], delete_untracked: true })
      } finally {
        spy.mockRestore()
      }
      expect(raced).toBe(true)
      expect(res.status).toBe(200)
      expect(existsSync(join(ws, 'transient.txt'))).toBe(false)
    } else {
      rmSync(join(ws, 'transient.txt'))
    }
    // `difflib` writes `+1` for a single-line untracked file, `+1,N` otherwise.
    writeFileSync(join(ws, 'one.txt'), 'only\n')
    writeFileSync(join(ws, 'two.txt'), 'a\nb\n')
    gitRunner.statusCache.clear()
    expect(String(((await json(await s.get(`/api/git/diff?session_id=${sid}&path=one.txt`))).diff as Json).diff)).toContain('@@ -0,0 +1 @@')
    expect(String(((await json(await s.get(`/api/git/diff?session_id=${sid}&path=two.txt`))).diff as Json).diff)).toContain('@@ -0,0 +1,2 @@')
    // An untracked symlink whose target stays inside the workspace is read through, as Python did.
    symlinkSync(join(ws, 'two.txt'), join(ws, 'inside-link.txt'))
    gitRunner.statusCache.clear()
    const row = (((await json(await s.get(`/api/git/status?session_id=${sid}`))).git as Json).files as Json[]).find((f) => f.path === 'inside-link.txt')
    expect(row).toMatchObject({ untracked: true, additions: 2 })
    expect(String(((await json(await s.get(`/api/git/diff?session_id=${sid}&path=inside-link.txt`))).diff as Json).diff)).toContain('+b')
    rmSync(join(ws, 'inside-link.txt'))
    rmSync(join(ws, 'one.txt'))
    rmSync(join(ws, 'two.txt'))
    // Checkout inputs follow Python: `require()` on mode, whitespace `dirty_mode` is not "block".
    res = await post(s, '/api/git/checkout', { session_id: sid, ref: 'main', mode: '' })
    expect((await json(res)).error).toBe('Missing required field(s): mode')
    res = await post(s, '/api/git/checkout', { session_id: sid, ref: 'main', mode: 'local', dirty_mode: '  ' })
    expect((await json(res)).code).toBe('dirty_worktree')
    // A workspace directory that no longer exists is `missing_git` on every route, as Python's `cwd=` failure was.
    const gone = join(s.state, 'gone-ws')
    mkdirSync(gone)
    expect((await post(s, '/api/workspaces/add', { path: gone })).status).toBe(200)
    const goneSid = String(((await json(await post(s, '/api/session/new', { workspace: gone }))).session as Json).session_id)
    rmSync(gone, { recursive: true, force: true })
    res = await s.get(`/api/git/status?session_id=${goneSid}`)
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'Git is not installed or not available on PATH', code: 'missing_git' })
    expect((await json(await s.get(`/api/git-info?session_id=${goneSid}`))).code).toBe('missing_git')
  })
})

describe('slow git off the event loop', () => {
  const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  let s: TestServer
  let shimDir: string
  let marker: string
  beforeAll(async () => {
    // A `git` shim that sleeps before every push and pull, so the command stays in flight while the test probes the server.
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    shimDir = mkdtempSync(join(tmpdir(), 'talaria-slow-git-'))
    marker = join(shimDir, 'push-started')
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = push ] || [ "$a" = pull ]; then touch '${marker}'; sleep 2; break; fi; done\nexec '${realGit}' "$@"\n`)
    chmodSync(join(shimDir, 'git'), 0o755)
    const env = { HERMES_WEBUI_WORKSPACE_GIT_DESTRUCTIVE: '1', ...identity, PATH: `${shimDir}:${process.env.PATH ?? ''}` }
    // A short lock wait so contention answers `operation_in_progress` well before the slow push finishes.
    s = await bootTestServer({ env, deps: (d) => { d.git = new GitRunner({ ...d.git.deps, env: { ...env, HOME: process.env.HOME }, mutationLockTimeoutMs: 200 }) } })
    const ws = join(s.state, 'workspace')
    const origin = join(s.state, 'origin.git')
    git(s.state, 'init', '-q', '--bare', origin)
    git(ws, 'init', '-q', '-b', 'main')
    writeFileSync(join(ws, 'README.md'), 'hello\n')
    git(ws, 'add', '.')
    git(ws, 'commit', '-q', '-m', 'init')
    git(ws, 'remote', 'add', 'origin', origin)
    git(ws, 'push', '-q', '-u', 'origin', 'main')
  })
  afterAll(async () => {
    await s.close()
    rmSync(shimDir, { recursive: true, force: true })
  })

  async function inFlight(sid: string, op = 'push'): Promise<{ push: Promise<Response>; settled: () => boolean }> {
    rmSync(marker, { force: true })
    let done = false
    const push = post(s, `/api/git/${op}`, { session_id: sid }).finally(() => { done = true })
    while (!existsSync(marker)) await new Promise((r) => setTimeout(r, 20))
    return { push, settled: () => done }
  }
  const pushInFlight = (sid: string): ReturnType<typeof inFlight> => inFlight(sid)

  it('serves another HTTP request while a push is in flight', async () => {
    const { sid } = await repoSession(s)
    const { push, settled } = await pushInFlight(sid)
    const health = await s.get('/health')
    expect(health.status).toBe(200)
    expect(settled()).toBe(false)
    const res = await push
    expect(res.status, await res.clone().text()).toBe(200)
  })

  it('a second mutation on the same repo during a push answers operation_in_progress', async () => {
    const { sid } = await repoSession(s)
    const { push, settled } = await pushInFlight(sid)
    const second = await post(s, '/api/git/fetch', { session_id: sid })
    expect(await json(second)).toMatchObject({ error: 'Another Git operation is still running', code: 'operation_in_progress' })
    expect(settled()).toBe(false)
    expect((await push).status).toBe(200)
    // The timed-out waiter's chain does not stay behind in the lock map.
    expect((s.deps.git as unknown as { locks: Map<string, unknown> }).locks.size).toBe(0)
  })

  it('no chat run or terminal starts in the workspace while a working-tree mutation runs', async () => {
    const { sid } = await repoSession(s)
    const { push: pull, settled } = await inFlight(sid, 'pull')
    let res = await post(s, '/api/chat/start', { session_id: sid, message: 'hi' })
    expect(await json(res)).toMatchObject({ error: 'A Git operation is running in this workspace.' })
    expect(res.status).toBe(409)
    res = await post(s, '/api/terminal/start', { session_id: sid })
    expect(await json(res)).toMatchObject({ error: 'A Git operation is running in this workspace.' })
    expect(res.status).toBe(409)
    expect(settled()).toBe(false)
    expect((await pull).status).toBe(200)
    // Released with the mutation.
    expect(s.deps.git.workspaceBusy(join(s.state, 'workspace'))).toBe(false)
  })

  it('a repo-wide mutation from a subdirectory workspace also keeps runs out of sibling workspaces', async () => {
    const ws = realpathSync(join(s.state, 'workspace'))
    for (const sub of ['sub-a', 'sub-b']) mkdirSync(join(ws, sub), { recursive: true })
    const sessionIn = async (dir: string): Promise<string> => {
      expect((await post(s, '/api/workspaces/add', { path: dir })).status).toBe(200)
      return String(((await json(await post(s, '/api/session/new', { workspace: dir }))).session as Json).session_id)
    }
    const sidA = await sessionIn(join(ws, 'sub-a'))
    const sidB = await sessionIn(join(ws, 'sub-b'))
    const { push: pull } = await inFlight(sidA, 'pull')
    const res = await post(s, '/api/chat/start', { session_id: sidB, message: 'hi' })
    expect(await json(res)).toMatchObject({ error: 'A Git operation is running in this workspace.' })
    expect((await pull).status).toBe(200)
  })

  it('a working-tree mutation refuses while a run is already active anywhere in the repository', async () => {
    const ws = realpathSync(join(s.state, 'workspace'))
    mkdirSync(join(ws, 'sub-c'), { recursive: true })
    expect((await post(s, '/api/workspaces/add', { path: join(ws, 'sub-c') })).status).toBe(200)
    const sid = String(((await json(await post(s, '/api/session/new', { workspace: join(ws, 'sub-c') }))).session as Json).session_id)
    // A run in a sibling directory that was admitted before the mutation took the repository hold.
    s.deps.registry.activeRuns.set('sibling-run', { stream_id: 'sibling-run', session_id: 'other', started_at: 0, phase: 'running', workspace: join(ws, 'sub-d'), model: null, provider: null, ephemeral: false })
    try {
      const res = await post(s, '/api/git/pull', { session_id: sid })
      expect(await json(res)).toMatchObject({ code: 'active_stream' })
      expect(res.status).toBe(409)
    } finally {
      s.deps.registry.activeRuns.delete('sibling-run')
    }
  })

  it('file writes, rollback restore, directory creation, and worktree sessions wait out a working-tree mutation', async () => {
    const { sid, ws } = await repoSession(s)
    const { push: pull } = await inFlight(sid, 'pull')
    const busy = { error: 'A Git operation is running in this workspace.' }
    const attempts: [string, unknown][] = [
      ['/api/file/create', { session_id: sid, path: 'new-during-pull.txt', content: 'x' }],
      ['/api/file/save', { session_id: sid, path: 'README.md', content: 'clobbered' }],
      ['/api/file/delete', { session_id: sid, path: 'README.md' }],
      ['/api/rollback/restore', { workspace: ws, checkpoint: 'abc' }],
      ['/api/workspaces/add', { path: join(ws, 'made-during-pull'), create: true }],
      ['/api/session/new', { workspace: ws, worktree: true }],
    ]
    for (const [route, body] of attempts) {
      const res = await post(s, route, body)
      expect({ route, status: res.status, body: await json(res) }).toMatchObject({ route, status: 409, body: busy })
    }
    expect(existsSync(join(ws, 'new-during-pull.txt'))).toBe(false)
    expect(existsSync(join(ws, 'made-during-pull'))).toBe(false)
    expect((await pull).status).toBe(200)
  })

  it('worktree removal waits for a Git mutation in its main checkout', async () => {
    const { sid, ws } = await repoSession(s)
    const worktree = join(realpathSync(s.state), 'wt-serial')
    git(ws, 'worktree', 'add', '-q', '-b', 'wt-serial', worktree)
    const wtSid = String(((await json(await post(s, '/api/session/new', { workspace: ws }))).session as Json).session_id)
    const session = s.deps.sessionStore.get(wtSid)
    Object.assign(session, { worktree_path: worktree, worktree_repo_root: ws })
    s.deps.sessionStore.save(session)
    const { push: pull } = await inFlight(sid, 'pull')
    const res = await post(s, '/api/session/worktree/remove', { session_id: wtSid })
    expect(await json(res)).toMatchObject({ code: 'operation_in_progress' })
    expect(existsSync(worktree)).toBe(true)
    expect((await pull).status).toBe(200)
    expect(await json(await post(s, '/api/session/worktree/remove', { session_id: wtSid }))).toMatchObject({ ok: true })
  })

  it('worktree removal holds the worktree busy from its lock checks through the removal', async () => {
    const { sid, ws } = await repoSession(s)
    const worktree = join(realpathSync(s.state), 'wt-remove')
    git(ws, 'worktree', 'add', '-q', '-b', 'wt-remove', worktree)
    const session = s.deps.sessionStore.get(sid)
    Object.assign(session, { worktree_path: worktree, worktree_repo_root: ws })
    s.deps.sessionStore.save(session)
    const seen: boolean[] = []
    const locks = s.deps.worktreeLocks
    s.deps.worktreeLocks = {
      lockedByStream: (sess) => { seen.push(s.deps.git.workspaceBusy(worktree)); return locks.lockedByStream(sess) },
      lockedByTerminal: (id, path) => { seen.push(s.deps.git.workspaceBusy(worktree)); return locks.lockedByTerminal(id, path) },
    }
    try {
      const res = await post(s, '/api/session/worktree/remove', { session_id: sid })
      expect(await json(res)).toMatchObject({ ok: true, removed_path: worktree })
    } finally {
      s.deps.worktreeLocks = locks
    }
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
    expect(s.deps.git.workspaceBusy(worktree)).toBe(false)
  })
})

describe('destructive gate', () => {
  it('rejects mutations with 403 until HERMES_WEBUI_WORKSPACE_GIT_DESTRUCTIVE=1', async () => {
    const s = await bootTestServer()
    try {
      git(join(s.state, 'workspace'), 'init', '-q')
      const { sid } = await repoSession(s)
      const res = await post(s, '/api/git/stage', { session_id: sid, paths: ['x'] })
      expect(res.status).toBe(403)
      expect(await json(res)).toEqual({ error: 'Destructive workspace Git operations are disabled. Set HERMES_WEBUI_WORKSPACE_GIT_DESTRUCTIVE=1 to enable them.', code: 'destructive_git_disabled' })
      // fetch is not destructive; without remotes git answers quietly.
      expect((await post(s, '/api/git/fetch', { session_id: sid })).status).toBe(200)
    } finally {
      await s.close()
    }
  })
})

describe('git helpers', () => {
  it('classifies git errors like the Python port', () => {
    expect(classifyGitError('fatal: not a git repository')).toBe('not_a_repo')
    expect(classifyGitError('error: failed to push some refs (non-fast-forward)', ['push'])).toBe('non_fast_forward')
    expect(classifyGitError('Your local changes would be overwritten by checkout')).toBe('dirty_worktree')
    expect(classifyGitError('something odd')).toBe('git_failed')
  })

  it('strips fences and quotes from generated commit messages', () => {
    expect(cleanGeneratedCommitMessage('```\nfix: thing\n```')).toBe('fix: thing')
    expect(cleanGeneratedCommitMessage('"quoted subject"')).toBe('quoted subject')
    expect(cleanGeneratedCommitMessage(null)).toBe('')
  })
})
