import { execFile, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Session } from '../sessions/session.js'
import { removeWorktreeForSession, worktreeStatusForSession } from './worktrees.js'
import { GitRunner } from './git.js'

vi.mock('node:child_process', async (original) => {
  const childProcess = await original<typeof import('node:child_process')>()
  return { ...childProcess, execFile: vi.fn(childProcess.execFile) }
})

const root = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-worktrees-')))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null' } })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout
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

describe('hardened worktree Git calls', () => {
  const unlocked = { lockedByStream: () => false, lockedByTerminal: () => false }
  let n = 0
  function setup(submoduleDepth = 0, objectFormat: 'sha1' | 'sha256' = 'sha1'): { repo: string; worktree: string; session: Session } {
    const repo = join(root, `secure-repo-${String(++n)}`)
    git(root, 'init', '-q', '-b', 'main', `--object-format=${objectFormat}`, repo)
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil\n')
    writeFileSync(join(repo, 'tracked.txt'), 'hello\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    let source: string | undefined
    for (let depth = 0; depth < submoduleDepth; depth++) {
      const next = join(root, `module-source-${String(n)}-${String(depth)}`)
      git(root, 'clone', '-q', '--local', repo, next)
      if (source) {
        git(next, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'module')
        git(next, 'commit', '-q', '-am', 'nested submodule')
      }
      source = next
    }
    if (source) {
      git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'module')
      git(repo, 'commit', '-q', '-am', 'submodule')
    }
    const worktree = join(root, `secure-wt-${String(n)}`)
    git(repo, 'worktree', 'add', '-q', '-b', `secure-wt-${String(n)}`, worktree)
    if (source) git(worktree, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive')
    git(worktree, 'branch', '--set-upstream-to=main')
    return { repo, worktree, session: { session_id: `secure-${String(n)}`, worktree_path: worktree, worktree_repo_root: repo } as unknown as Session }
  }

  function afterMove(write: (captured: string) => void | Promise<void>) {
    const original = Reflect.get(GitRunner.prototype, 'run')
    return vi.spyOn(GitRunner.prototype, 'run').mockImplementation(async function (this: GitRunner, ...args) {
      const result = await original.apply(this, args)
      if (args[1][0] === 'worktree' && args[1][1] === 'move' && result.status === 0) await write(args[1].at(-1) ?? '')
      return result
    })
  }

  it('scans submodule filters once per status poll, excluding metadata-only probes', async () => {
    const { session } = setup(2)
    vi.mocked(execFile).mockClear()
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: false, listed: true, ahead_behind: { available: true } })
    const commands = vi.mocked(execFile).mock.calls.map((call) => call[1] as string[])
    expect(commands.filter((args) => args.includes('ls-files'))).toHaveLength(3)
    expect(commands.length).toBeLessThanOrEqual(16)
  })

  for (const ignore of ['all', 'dirty', 'untracked', 'none']) {
    it(`preserves Git's submodule ignore=${ignore} behavior`, async () => {
      const { worktree, session } = setup(1)
      const submodule = join(worktree, 'module')
      git(worktree, 'config', 'submodule.module.ignore', ignore)
      const check = async (): Promise<void> => {
        const expected = git(worktree, 'status', '--porcelain', '-z', '--untracked-files=normal')
        expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: expected.length > 0, untracked_count: 0 })
      }
      writeFileSync(join(submodule, 'notes.txt'), 'new\n')
      await check()
      writeFileSync(join(submodule, 'tracked.txt'), 'changed\n')
      await check()
      git(submodule, 'add', '.')
      git(submodule, 'commit', '-q', '-m', 'child change')
      await check()
      git(worktree, 'add', 'module')
      await check()
    })
  }

  it('honors .gitmodules ignore settings with case-sensitive submodule names', async () => {
    const { worktree, session } = setup(1)
    git(worktree, 'config', '--file', '.gitmodules', '--rename-section', 'submodule.module', 'submodule.MixedCase')
    git(worktree, 'config', '--file', '.gitmodules', 'submodule.MixedCase.ignore', 'all')
    git(worktree, 'add', '.gitmodules')
    git(worktree, 'commit', '-q', '-m', 'ignore submodule changes')
    writeFileSync(join(worktree, 'module', 'tracked.txt'), 'changed\n')
    expect(git(worktree, 'status', '--porcelain')).toBe('')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: false })
  })

  it('restores the captured directory and Git registration when its final probe finds new data', async () => {
    const { worktree, session } = setup()
    const spy = afterMove((captured) => { writeFileSync(join(captured, 'late.txt'), 'keep me\n') })
    try { await expect(removeWorktreeForSession(session, unlocked)).rejects.toThrow('git worktree remove failed') } finally { spy.mockRestore() }
    expect(readFileSync(join(worktree, 'late.txt'), 'utf8')).toBe('keep me\n')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ exists: true, listed: true, dirty: true })
  })

  it('holds the private capture against new file, terminal and Git mutation admission', async () => {
    const { repo, worktree, session } = setup()
    const runner = new GitRunner({ env: { ...process.env, HERMES_WEBUI_WORKSPACE_GIT_DESTRUCTIVE: '1' } })
    const spy = afterMove(async (captured) => {
      expect(runner.workspaceBusy(captured)).toBe(true)
      expect(() => runner.holdWrite(captured, () => Promise.resolve())).toThrow('A Git operation is running in this workspace.')
      await expect(runner.stage(captured, ['tracked.txt'])).rejects.toThrow('A Git operation is running in this workspace.')
    })
    try { expect(await runner.removeWorktreeExclusive(worktree, repo, () => removeWorktreeForSession(session, unlocked))).toMatchObject({ ok: true }) } finally { spy.mockRestore() }
  })

  it('leaves a replacement at the original path untouched after capturing the worktree', async () => {
    const { worktree, session } = setup()
    const spy = afterMove(() => {
      mkdirSync(worktree)
      writeFileSync(join(worktree, 'replacement.txt'), 'keep me\n')
    })
    try { expect(await removeWorktreeForSession(session, unlocked)).toMatchObject({ ok: true, warnings: ['The original worktree path was recreated during removal and was left untouched.'] }) } finally { spy.mockRestore() }
    expect(readFileSync(join(worktree, 'replacement.txt'), 'utf8')).toBe('keep me\n')
    expect(git(session.worktree_repo_root ?? '', 'worktree', 'list', '--porcelain')).not.toContain(`worktree ${worktree}\n`)
  })

  it('retains the captured worktree when a replacement prevents restoring its original path', async () => {
    const { worktree, session } = setup()
    let captured = ''
    const spy = afterMove((path) => {
      captured = path
      writeFileSync(join(captured, 'late.txt'), 'captured data\n')
      mkdirSync(worktree)
      writeFileSync(join(worktree, 'replacement.txt'), 'replacement data\n')
    })
    try { await expect(removeWorktreeForSession(session, unlocked)).rejects.toThrow('Worktree retained at') } finally { spy.mockRestore() }
    expect(readFileSync(join(worktree, 'replacement.txt'), 'utf8')).toBe('replacement data\n')
    expect(readFileSync(join(captured, 'late.txt'), 'utf8')).toBe('captured data\n')
    expect(readFileSync(join(captured, 'tracked.txt'), 'utf8')).toBe('hello\n')
    expect(JSON.parse(readFileSync(join(dirname(captured), 'recovery.json'), 'utf8'))).toMatchObject({ original_path: worktree })
  })

  it.runIf(process.platform !== 'win32')('rejects non-regular metadata without opening a blocking FIFO reader', async () => {
    const { worktree, session } = setup()
    const index = join(git(worktree, 'rev-parse', '--absolute-git-dir').trim(), 'index')
    unlinkSync(index)
    const fifo = spawnSync('mkfifo', [index], { encoding: 'utf8' })
    expect(fifo.status, fifo.stderr).toBe(0)
    await expect(worktreeStatusForSession(session, unlocked)).rejects.toThrow('Git status metadata must be a regular file')
  })

  it('preserves info excludes, CRLF normalization and split indexes without modifying repository metadata', async () => {
    const { repo, worktree, session } = setup()
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'ignored.txt\n')
    writeFileSync(join(worktree, '.gitattributes'), '*.txt text eol=lf\n')
    git(worktree, 'add', '.gitattributes')
    git(worktree, 'commit', '-q', '-m', 'text normalization')
    git(worktree, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(worktree, 'tracked.txt'), 'hello\r\n')
    git(worktree, 'add', 'tracked.txt')
    writeFileSync(join(worktree, 'ignored.txt'), 'ignored\n')
    git(worktree, 'update-index', '--split-index')
    const index = join(git(worktree, 'rev-parse', '--absolute-git-dir').trim(), 'index')
    const before = readFileSync(index)
    expect(git(worktree, '--no-optional-locks', 'status', '--porcelain')).toBe('')
    expect((await new GitRunner({ env: process.env }).worktreeStatus(worktree)).stdout).toBe('')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: false, untracked_count: 0 })
    expect(readFileSync(index)).toEqual(before)
    writeFileSync(join(worktree, 'tracked.txt'), 'changed\r\n')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: true, untracked_count: 0 })
  })

  it('preserves sparse-index status and SHA-256 repositories', async () => {
    const { worktree, session } = setup(0, 'sha256')
    mkdirSync(join(worktree, 'visible'))
    mkdirSync(join(worktree, 'hidden'))
    writeFileSync(join(worktree, 'visible', 'file.txt'), 'visible\n')
    writeFileSync(join(worktree, 'hidden', 'file.txt'), 'hidden\n')
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-q', '-m', 'directories')
    git(worktree, 'sparse-checkout', 'init', '--cone', '--sparse-index')
    git(worktree, 'sparse-checkout', 'set', 'visible')
    expect(git(worktree, '--no-optional-locks', 'status', '--porcelain')).toBe('')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: false })
    writeFileSync(join(worktree, 'visible', 'file.txt'), 'changed\n')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: true })
  })

  it('does not execute a filter installed after discovery before status starts', async () => {
    const { worktree, session } = setup()
    const marker = join(root, `late-filter-${String(n)}`)
    const original = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    vi.mocked(execFile).mockImplementation((...args: Parameters<typeof execFile>) => {
      if ((args[1] as string[]).includes('status')) {
        git(worktree, 'config', 'filter.late.clean', `printf late >> "${marker}"; cat`)
        writeFileSync(join(worktree, '.gitattributes'), '*.txt filter=late\n')
        utimesSync(join(worktree, 'tracked.txt'), 1, 1)
      }
      return original.execFile(...args)
    })
    try {
      await worktreeStatusForSession(session, unlocked)
      expect(existsSync(marker)).toBe(false)
    } finally { vi.mocked(execFile).mockImplementation(original.execFile) }
  })

  it('does not execute a filter installed immediately before the removal command', async () => {
    const { repo, session } = setup()
    const marker = join(root, `remove-late-filter-${String(n)}`)
    const original = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    vi.mocked(execFile).mockImplementation((...args: Parameters<typeof execFile>) => {
      const argv = args[1] as string[]
      if (argv.includes('worktree') && argv.includes('remove')) {
        git(repo, 'config', 'filter.late.clean', `printf late >> "${marker}"; cat`)
        writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.txt filter=late\n')
        utimesSync(join(argv.at(-1) ?? '', 'tracked.txt'), 1, 1)
      }
      return original.execFile(...args)
    })
    try {
      expect(await removeWorktreeForSession(session, unlocked)).toMatchObject({ ok: true })
      expect(existsSync(marker)).toBe(false)
    } finally { vi.mocked(execFile).mockImplementation(original.execFile) }
  })

  for (const depth of [1, 2]) {
    for (const operation of ['status', 'remove', 'remove --force'] as const) {
      it(`does not execute depth-${String(depth)} submodule filters during ${operation}`, async () => {
        const { worktree, session } = setup(depth)
        const submodule = join(worktree, ...Array<string>(depth).fill('module'))
        const marker = join(root, `submodule-executed-${String(n)}`)
        git(submodule, 'config', 'filter.evil.clean', `printf clean >> "${marker}"; cat`)
        utimesSync(join(submodule, 'tracked.txt'), 1, 1)
        if (operation === 'status') {
          expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: false, untracked_count: 0, force_required: false })
          writeFileSync(join(submodule, 'tracked.txt'), 'changed\n')
          expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: true, untracked_count: 0, force_required: true })
        } else if (operation === 'remove') {
          // Git preserves initialized submodules unless force was explicitly requested.
          await expect(removeWorktreeForSession(session, unlocked)).rejects.toThrow('git worktree remove failed')
          expect(existsSync(worktree)).toBe(true)
        } else {
          expect(await removeWorktreeForSession(session, unlocked, { force: true })).toMatchObject({ ok: true })
          expect(existsSync(worktree)).toBe(false)
        }
        expect(existsSync(marker), existsSync(marker) ? readFileSync(marker, 'utf8') : 'no submodule program executed').toBe(false)
      })
    }
  }

  for (const scope of ['local', 'worktree'] as const) {
    for (const operation of ['status', 'remove', 'remove --force'] as const) {
      it(`does not execute ${scope} fsmonitor or filter programs during ${operation}`, async () => {
        const { repo, worktree, session } = setup()
        const marker = join(root, `executed-${String(n)}`)
        if (scope === 'worktree') git(repo, 'config', 'extensions.worktreeConfig', 'true')
        git(worktree, 'config', `--${scope}`, 'core.fsmonitor', `printf fsmonitor >> "${marker}"`)
        git(worktree, 'config', `--${scope}`, 'filter.evil.clean', `printf clean >> "${marker}"; cat`)
        git(worktree, 'config', `--${scope}`, 'filter.evil.smudge', `printf smudge >> "${marker}"; cat`)
        let stamp = 1
        const statDirty = (): void => { utimesSync(join(worktree, 'tracked.txt'), stamp, stamp++) }
        statDirty()
        expect(existsSync(marker)).toBe(false)
        if (operation === 'status') {
          expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ listed: true, dirty: false, untracked_count: 0, force_required: false })
        } else {
          let terminalChecks = 0
          const locks = { ...unlocked, lockedByTerminal: () => {
            // Git's internal removal check must rescan the target after our status probe refreshed its index.
            if (++terminalChecks === 2) statDirty()
            return false
          } }
          expect(await removeWorktreeForSession(session, locks, { force: operation === 'remove --force' })).toMatchObject({ ok: true, warnings: null })
          expect(existsSync(worktree)).toBe(false)
        }
        expect(existsSync(marker), existsSync(marker) ? readFileSync(marker, 'utf8') : 'no repository program executed').toBe(false)
      })
    }
  }

  it('preserves clean, dirty, untracked, ahead and forced-removal behavior', async () => {
    const { worktree, session } = setup()
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ exists: true, listed: true, dirty: false, untracked_count: 0, force_required: false, ahead_behind: { ahead: 0, behind: 0, available: true, upstream: 'main' } })
    writeFileSync(join(worktree, 'tracked.txt'), 'changed\n')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: true, untracked_count: 0, force_required: true })
    await expect(removeWorktreeForSession(session, unlocked)).rejects.toThrow('Worktree has uncommitted changes')
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-q', '-m', 'ahead')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: false, force_required: true, ahead_behind: { ahead: 1, behind: 0, available: true } })
    await expect(removeWorktreeForSession(session, unlocked)).rejects.toThrow('Worktree has 1 unpushed commit(s)')
    writeFileSync(join(worktree, 'notes.txt'), 'untracked\n')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: true, untracked_count: 1, force_required: true })
    expect(await removeWorktreeForSession(session, unlocked, { force: true })).toMatchObject({ ok: true, warnings: ['1 untracked file(s) will be removed.', '1 unpushed commit(s) will be removed.'] })
    expect(existsSync(worktree)).toBe(false)
  })

  it('preserves unavailable-Git status defaults and removal error wording', async () => {
    const { session } = setup()
    vi.stubEnv('PATH', join(root, 'missing-bin'))
    try {
      expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ exists: true, listed: false, dirty: false, untracked_count: 0, ahead_behind: { available: false } })
      await expect(removeWorktreeForSession(session, unlocked)).rejects.toThrow("Failed to remove worktree: [Errno 2] No such file or directory: 'git'")
    } finally { vi.unstubAllEnvs() }
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

  it('restores the include symlinks when git refuses the removal', async () => {
    const { repo, worktree, session } = setup()
    const link = join(worktree, 'node_modules')
    symlinkSync(join(repo, 'node_modules'), link)
    // A real untracked file appears after the status probe; git's own check refuses it.
    let terminalChecks = 0
    const locks = { lockedByStream: () => false, lockedByTerminal: () => {
      if (++terminalChecks === 2) writeFileSync(join(worktree, 'notes.txt'), 'mine\n')
      return false
    } }
    await expect(removeWorktreeForSession(session, locks)).rejects.toThrow('git worktree remove failed')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync(join(repo, 'node_modules')))
  })

  it('ignores a nested include symlink that git reports as its untracked parent directory', async () => {
    const { repo, worktree, session } = setup()
    writeFileSync(join(repo, '.worktreeinclude'), 'vendor/node_modules/\n')
    mkdirSync(join(repo, 'vendor', 'node_modules'), { recursive: true })
    mkdirSync(join(worktree, 'vendor'))
    symlinkSync(join(repo, 'vendor', 'node_modules'), join(worktree, 'vendor', 'node_modules'))
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: false, untracked_count: 0, force_required: false })
    writeFileSync(join(worktree, 'vendor', 'notes.txt'), 'mine\n')
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: true, untracked_count: 1 })
    unlinkSync(join(worktree, 'vendor', 'notes.txt'))
    expect(await removeWorktreeForSession(session, unlocked)).toMatchObject({ ok: true, removed_path: worktree })
    expect(lstatSync(join(repo, 'vendor', 'node_modules')).isDirectory()).toBe(true)
  })

  it('still counts a symlink that points elsewhere', async () => {
    const { worktree, session } = setup()
    const elsewhere = join(root, `elsewhere-${String(n)}`)
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(worktree, 'node_modules'))
    expect(await worktreeStatusForSession(session, unlocked)).toMatchObject({ dirty: true, untracked_count: 1, force_required: true })
  })
})
