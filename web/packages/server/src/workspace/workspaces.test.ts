import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigUnavailable } from '../config/agent-config.js'
import { JsonDocuments } from '../sessions/storage/json-documents.js'
import { bootTestServer } from '../test/harness.js'
import { folderBrowse, isBlockedSystemPath, isBlockedWorkspacePath, WorkspaceRegistry, type WorkspaceDeps } from './workspaces.js'

const realpathProbes = vi.hoisted(() => [] as string[])

// Both entry points: `resolvePathLikePython` walks with `.native`, other callers use the plain call.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const record = (fn: (path: string) => string) => (path: string): string => {
    realpathProbes.push(path)
    return fn(path)
  }
  return { ...fs, realpathSync: Object.assign(record(fs.realpathSync as (path: string) => string), { native: record(fs.realpathSync.native as (path: string) => string) }) }
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(profile = 'default') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-workspaces-')))
  roots.push(root)
  const home = join(root, 'home')
  const state = join(root, 'state')
  const profileHome = (name: string): string => name === 'default' ? home : join(home, '.hermes', 'profiles', name)
  const directory = profile === 'default' ? state : join(profileHome(profile), 'webui_state')
  mkdirSync(directory, { recursive: true })
  mkdirSync(home, { recursive: true })
  const entries = [{ path: join(root, 'project'), name: 'Talaria' }, { path: join(root, 'other'), name: 'Other' }]
  for (const entry of entries) mkdirSync(entry.path)
  const file = join(directory, 'workspaces.json')
  const bytes = JSON.stringify(entries, null, 4) + '\n'
  writeFileSync(file, bytes)
  const profileConfig = vi.fn<WorkspaceDeps['profileConfig']>(() => null)
  const documents = new JsonDocuments(state, profileHome)
  const registry = new WorkspaceRegistry({ documents, defaultWorkspace: () => home, profileHome, activeProfile: () => profile, isRootProfileHome: (path) => path === home, profileConfig, home })
  return { registry, documents, profileConfig, file, bytes, entries, home }
}

describe('blocked system paths (TAL-1725)', () => {
  const symlinkedEtc = join(realpathSync('/etc'), 'talaria-missing')

  it.each<[string, string | null, boolean]>([
    ['/', null, true],
    ['/etc', null, true],
    ['/etc/nginx', null, true],
    [symlinkedEtc, null, true],
    [symlinkedEtc, '/etc/talaria-missing', true],
    ['/private/etc/hosts', null, true],
    ['/private/var', null, true],
    ['/private/var/db', null, true],
    ['/private/var/folders/ab/project', null, false],
    ['/private/var/tmp/project', null, false],
    ['/var/folders/ab/project', '/var/folders/ab/project', false],
    ['/var/tmp/project', null, false],
    ['/usr/local/bin', null, true],
    ['/opt/homebrew/bin', null, true],
    ['/System/Library', null, true],
    ['/Library/Caches', null, true],
    ['/opt/talaria', null, false],
    ['/srv/talaria/project', '/srv/talaria/project', false],
    ['/srv/talaria/project', '/etc/project', true],
  ])('isBlockedWorkspacePath(%s, %s) is %s', (candidate, raw, blocked) => {
    expect(isBlockedWorkspacePath(candidate, raw)).toBe(blocked)
  })

  it.each<[string, boolean]>([
    ['/etc/hosts', true],
    [symlinkedEtc, true],
    ['/usr/share', true],
    ['/var/folders/ab/project', false],
    ['/private/var/tmp/project', false],
    ['/srv/talaria/project', false],
  ])('isBlockedSystemPath(%s) is %s', (candidate, blocked) => {
    expect(isBlockedSystemPath(candidate)).toBe(blocked)
  })

  it('resolves the system paths once, on the first check', async () => {
    vi.resetModules()
    const fresh = await import('./workspaces.js')
    realpathProbes.length = 0
    expect(fresh.isBlockedWorkspacePath('/srv/talaria/project', '/srv/talaria/project')).toBe(false)
    expect(realpathProbes.length).toBeGreaterThan(0)
    expect(realpathProbes.length).toBeLessThanOrEqual(20)
    realpathProbes.length = 0
    for (let i = 0; i < 999; i += 1) fresh.isBlockedWorkspacePath('/srv/talaria/project', '/srv/talaria/project')
    expect(realpathProbes).toEqual([])
  })

  it('lists 500 blocked symlinks without re-resolving the system paths per entry', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-blocked-links-')))
    roots.push(workspace)
    for (let i = 0; i < 500; i += 1) symlinkSync('/usr/share', join(workspace, `link-${i}`))
    vi.resetModules()
    const { listDir } = await import('./fs.js')
    realpathProbes.length = 0
    expect(listDir(workspace)).toEqual([])
    const systemProbes = realpathProbes.filter((path) => path !== '/usr/share' && !path.startsWith(workspace))
    expect(systemProbes.length).toBeLessThanOrEqual(20)
  })
})

describe('workspace registry config availability (TAL-730)', () => {
  it.each(['default', 'work'])('preserves %s registry bytes on unresolved reads and restores names after recovery', async (profile) => {
    const f = fixture(profile)
    expect(await f.registry.load()).toEqual([{ path: f.home, name: 'Home' }])
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes)
    expect(await f.registry.suggest()).toEqual([])
    f.profileConfig.mockReturnValue({})
    expect(await f.registry.load()).toEqual(f.entries)
  })

  it('preserves the global registry when no per-profile registry exists', async () => {
    const f = fixture()
    expect(await f.registry.load('default')).toEqual([{ path: f.home, name: 'Home' }])
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes)
  })

  it.each(['null', 'throw'])('refuses saves when config is %s without touching the registry', async (mode) => {
    const f = fixture()
    if (mode === 'throw') f.profileConfig.mockImplementation(() => { throw new Error('unreadable config') })
    await expect(f.registry.save([])).rejects.toBeInstanceOf(ConfigUnavailable)
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes)
  })

  it('refuses mutation reads if config becomes unresolved while loading the registry', async () => {
    const f = fixture()
    f.profileConfig.mockReturnValue({})
    const read = f.documents.get.bind(f.documents)
    vi.spyOn(f.documents, 'get').mockImplementation(async (...args) => {
      const record = await read(...args)
      f.profileConfig.mockReturnValue(null)
      return record
    })
    await expect(f.registry.load(null, { forWrite: true })).rejects.toBeInstanceOf(ConfigUnavailable)
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes)
  })

  it('still persists pruning for a resolved remote backend', async () => {
    const f = fixture()
    f.profileConfig.mockReturnValue({ terminal: { backend: 'ssh', cwd: '/srv' } })
    expect(await f.registry.load()).toEqual([{ path: '/srv', name: 'Home' }])
    expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual([])
  })
})

describe('default workspace behind a symlink (TAL-2098)', () => {
  it('ships the settings default workspace in the same spelling as its workspace list entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talaria-ws-link-'))
    const real = join(dir, 'real')
    mkdirSync(real)
    const link = join(dir, 'link')
    symlinkSync(real, link)
    const s = await bootTestServer({ env: { HERMES_WEBUI_DEFAULT_WORKSPACE: link } })
    try {
      const settings = await (await s.get('/api/settings')).json() as { default_workspace: string }
      const listed = await (await s.get('/api/workspaces')).json() as { workspaces: { path: string }[] }
      expect(listed.workspaces.map((w) => w.path)).toContain(realpathSync(link))
      expect(settings.default_workspace).toBe(realpathSync(link))
    } finally {
      await s.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('workspace list row fields (TAL-2141)', () => {
  const post = (s: Awaited<ReturnType<typeof bootTestServer>>, path: string, body: unknown) => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  interface Entry { path: string; is_default?: boolean; exists?: boolean; display_path?: string; chat_count?: number }

  it('marks the symlinked default, flags a missing folder, writes home as ~ and counts chats', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-ws-home-')))
    vi.stubEnv('HOME', home)
    const real = join(home, 'real')
    const link = join(home, 'link')
    const gone = join(home, 'projects', 'gone')
    mkdirSync(real)
    mkdirSync(gone, { recursive: true })
    symlinkSync(real, link)
    const s = await bootTestServer({ env: { HOME: home, HERMES_WEBUI_DEFAULT_WORKSPACE: link } })
    try {
      expect((await post(s, '/api/workspaces/add', { path: gone })).status).toBe(200)
      for (let i = 0; i < 2; i++) {
        const { session } = await (await post(s, '/api/session/new', { workspace: link })).json() as { session: { session_id: string } }
        await s.deps.sessionStore.save(await s.deps.sessionStore.get(session.session_id))
      }
      rmSync(gone, { recursive: true })
      const listed = await (await s.get('/api/workspaces')).json() as { workspaces: Entry[] }
      expect(listed.workspaces.map(({ path, is_default, exists, display_path, chat_count }) => ({ path, is_default, exists, display_path, chat_count }))).toEqual([
        { path: real, is_default: true, exists: true, display_path: '~/real', chat_count: 2 },
        { path: gone, is_default: false, exists: false, display_path: '~/projects/gone', chat_count: 0 },
      ])
      const browsed = await (await s.get(`/api/workspaces/suggest?prefix=${encodeURIComponent(`${home}/`)}`)).json() as ReturnType<typeof folderBrowse>
      expect(browsed.folders).toContainEqual({ path: join(home, 'projects'), name: 'projects', target: `${join(home, 'projects')}/` })
      expect(browsed.parent).toBe(`${join(home, '..')}/`)
    } finally {
      await s.close()
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('workspace list row fields for a remote terminal profile (TAL-2141)', () => {
  it('leaves folder existence unknown when the backend is remote, even without a terminal cwd', async () => {
    const s = await bootTestServer()
    const config = vi.spyOn(s.deps.agentConfig, 'peekResolved').mockReturnValue({ terminal: { backend: 'ssh' } })
    try {
      const listed = await (await s.get('/api/workspaces')).json() as { workspaces: Record<string, unknown>[]; terminal_remote_backend: boolean }
      expect(listed.terminal_remote_backend).toBe(true)
      expect(listed.workspaces.length).toBeGreaterThan(0)
      expect(listed.workspaces.filter((w) => 'exists' in w)).toEqual([])
    } finally {
      config.mockRestore()
      await s.close()
    }
  })
})

describe('Add space folder browser (TAL-2141)', () => {
  it('goes up exactly one folder whether or not the prefix ends in a separator', () => {
    expect(folderBrowse('/home/me/git', [], '/home/me').parent).toBe('/home/me/')
    expect(folderBrowse('/home/me/git/', [], '/home/me').parent).toBe('/home/me/')
    expect(folderBrowse('/home', [], '/home/me').parent).toBe('/')
    expect(folderBrowse('~/git', [], '/home/me').parent).toBe('~/')
    expect(folderBrowse('~', [], '/home/me').parent).toBe('')
    expect(folderBrowse('/', [], '/home/me').parent).toBeNull()
    expect(folderBrowse('', [], '/home/me').parent).toBeNull()
  })

  it('names each folder by its last segment and the space by the prefix\'s last folder', () => {
    expect(folderBrowse('~/', ['~', '/srv/work/', '/'], '/home/me')).toEqual({
      folders: [{ path: '~', name: '~', target: '~/' }, { path: '/srv/work/', name: 'work', target: '/srv/work/' }, { path: '/', name: '/', target: '/' }],
      parent: '',
      default_name: 'me',
    })
    expect(folderBrowse('/srv/work/', [], '/home/me').default_name).toBe('work')
    expect(folderBrowse('', [], '/home/me').default_name).toBeNull()
  })
})
