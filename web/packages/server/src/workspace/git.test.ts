import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { cleanGeneratedCommitMessage, classifyGitError } from './git.js'

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
    expect(untracked.diff).toBe('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+fresh\n')
    expect((await s.get(`/api/git/diff?session_id=${sid}&path=../outside`)).status).toBe(400)
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
