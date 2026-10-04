import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Session } from '../sessions/session.js'
import { removeWorktreeForSession } from './worktrees.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-worktrees-')))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null' } })
  if (r.status !== 0) throw new Error(r.stderr)
}

describe('removeWorktreeForSession', () => {
  it('rechecks the stream and terminal locks after its Git probes, right before removing', async () => {
    const repo = join(root, 'repo')
    git(root, 'init', '-q', '-b', 'main', repo)
    writeFileSync(join(repo, 'README.md'), 'hello\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    const worktree = join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'wt', worktree)
    const session = { session_id: 'abc123', worktree_path: worktree, worktree_repo_root: repo } as unknown as Session
    // Unlocked when the status probe reads the flags; a stream starts while the awaited Git probes run.
    let streamChecks = 0
    const locks = { lockedByStream: () => ++streamChecks > 1, lockedByTerminal: () => false }
    await expect(removeWorktreeForSession(session, locks)).rejects.toThrow('Worktree is locked by an active streaming session')
    expect(existsSync(worktree)).toBe(true)
    // Unlocked throughout: removal proceeds.
    expect(await removeWorktreeForSession(session, { lockedByStream: () => false, lockedByTerminal: () => false })).toMatchObject({ ok: true, removed_path: worktree })
    expect(existsSync(worktree)).toBe(false)
  })
})
