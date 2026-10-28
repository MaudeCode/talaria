import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigUnavailable } from '../config/agent-config.js'
import { JsonDocuments } from '../sessions/storage/json-documents.js'
import { WorkspaceRegistry, type WorkspaceDeps } from './workspaces.js'

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
