/** `memory.get` stays off the event loop: no sync spawn or fs, and one toplevel lookup per repository workspace (TAL-1732). */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncFsCalls } from '../test/sync-fs.js'
import { GitRunner } from '../workspace/git.js'
import { memoryRevision, readMemory, readProjectContext } from './memory.js'

vi.mock('node:fs', { spy: true })
vi.mock('node:child_process', { spy: true })

describe('memory.get', () => {
  let root: string
  const key = Buffer.from('signing-key')
  const write = (rel: string, body: string): string => {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    return path
  }
  const gitInit = (rel: string): void => { execFileSync('git', ['init', '--quiet', join(root, rel)]) }

  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-get-'))) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('answers the same payload with no sync spawn or fs call, and asks git for the toplevel once', async () => {
    const memory = write('profile/memories/MEMORY.md', 'remember\n')
    const user = write('profile/memories/USER.md', 'user\n')
    const soul = write('profile/SOUL.md', 'soul\n')
    gitInit('repo')
    const hermes = write('repo/HERMES.md', '---\ntitle: x\n---\nrepo context\n')
    const agents = write('repo/apps/web/AGENTS.md', 'agents\n')
    const workspace = join(root, 'repo', 'apps', 'web')
    const git = new GitRunner({ env: process.env })
    const toplevel = vi.spyOn(git, 'run')
    const [memoryMtime, userMtime, soulMtime, hermesMtime, agentsMtime] = [memory, user, soul, hermes, agents].map((path) => statSync(path).mtimeMs / 1000)
    vi.clearAllMocks()

    const first = await readMemory(join(root, 'profile'), {}, workspace, {}, false, key, git)

    expect(first).toEqual({
      memory: 'remember\n', user: 'user\n', soul: 'soul\n', project_context: 'repo context\n',
      memory_revision: memoryRevision(key, Buffer.from('remember\n')), user_revision: memoryRevision(key, Buffer.from('user\n')), soul_revision: memoryRevision(key, Buffer.from('soul\n')),
      memory_path: memory, user_path: user, soul_path: soul, project_context_path: hermes, project_context_name: 'HERMES.md', project_context_workspace: workspace,
      memory_mtime: memoryMtime, user_mtime: userMtime, soul_mtime: soulMtime, project_context_mtime: hermesMtime,
      project_context_shadowed: [{ name: 'AGENTS.md', path: agents, mtime: agentsMtime, shadowed_by: 'HERMES.md', shadowed_by_path: hermes }],
      external_notes_enabled: false,
    })
    expect(syncFsCalls()).toEqual([])
    expect(spawnSync).not.toHaveBeenCalled()

    expect(await readMemory(join(root, 'profile'), {}, workspace, {}, false, key, git)).toEqual(first)
    expect(toplevel).toHaveBeenCalledTimes(1)
  })

  it('sees a workspace that became a repository after it was first read', async () => {
    write('outer/HERMES.md', 'outer context\n')
    mkdirSync(join(root, 'outer', 'ws'))
    const workspace = join(root, 'outer', 'ws')
    const git = new GitRunner({ env: process.env })
    expect((await readProjectContext(workspace, git)).content).toBe('')
    gitInit('outer')
    expect((await readProjectContext(workspace, git)).content).toBe('outer context\n')
  })
})
