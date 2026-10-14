import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Session } from '../sessions/session.js'
import { removeWorktreeForSession, worktreeStatusForSession } from './worktrees.js'

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

describe('.worktreeinclude symlinks', () => {
  const unlocked = { lockedByStream: () => false, lockedByTerminal: () => false }
  let n = 0
  // The Agent's `_setup_worktree` layout: `node_modules/` gitignored and listed in `.worktreeinclude`, symlinked back to the main checkout.
  function setup(): { repo: string; worktree: string; session: Session } {
    const repo = join(root, `include-repo-${String(++n)}`)
    git(root, 'init', '-q', '-b', 'main', repo)
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(repo, '.worktreeinclude'), '# deps\nnode_modules/\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    mkdirSync(join(repo, 'node_modules'))
    const worktree = join(root, `include-wt-${String(n)}`)
    git(repo, 'worktree', 'add', '-q', '-b', `include-wt-${String(n)}`, worktree)
    return { repo, worktree, session: { session_id: `s${String(n)}`, worktree_path: worktree, worktree_repo_root: repo } as unknown as Session }
  }

  it('ignores the symlink back to the main checkout and removes without force', async () => {
    const { repo, worktree, session } = setup()
    symlinkSync(join(repo, 'node_modules'), join(worktree, 'node_modules'))
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: false, untracked_count: 0, force_required: false })
    expect(await removeWorktreeForSession(session, unlocked)).toMatchObject({ ok: true, removed_path: worktree, warnings: null })
    expect(existsSync(worktree)).toBe(false)
    expect(lstatSync(join(repo, 'node_modules')).isDirectory()).toBe(true)
  })

  it('still counts a real untracked file beside the symlink', async () => {
    const { repo, worktree, session } = setup()
    symlinkSync(join(repo, 'node_modules'), join(worktree, 'node_modules'))
    writeFileSync(join(worktree, 'notes.txt'), 'mine\n')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: true, untracked_count: 1, force_required: true })
    await expect(removeWorktreeForSession(session, unlocked)).rejects.toThrow('Worktree has uncommitted changes. Use force=true to override.')
    expect(existsSync(join(worktree, 'node_modules'))).toBe(true)
  })

  it('keeps a real file that replaced the symlink after the status probe', async () => {
    const { repo, worktree, session } = setup()
    const link = join(worktree, 'node_modules')
    symlinkSync(join(repo, 'node_modules'), link)
    // The terminal lock is read once by the probe and rechecked right before removal; swap the symlink in between.
    let terminalChecks = 0
    const locks = { lockedByStream: () => false, lockedByTerminal: () => {
      if (++terminalChecks === 2) { unlinkSync(link); writeFileSync(link, 'mine\n') }
      return false
    } }
    await expect(removeWorktreeForSession(session, locks)).rejects.toThrow()
    expect(readFileSync(link, 'utf8')).toBe('mine\n')
  })

  it('still counts a symlink that points elsewhere', async () => {
    const { worktree, session } = setup()
    const elsewhere = join(root, `elsewhere-${String(n)}`)
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(worktree, 'node_modules'))
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: true, untracked_count: 1, force_required: true })
  })
})
