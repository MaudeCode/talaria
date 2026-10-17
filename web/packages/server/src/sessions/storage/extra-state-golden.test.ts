import { testSessionDocuments } from '../../test/storage.js'
import { testProfileIdentity } from '../../test/storage.js'
import { JsonDocuments } from '../../test/storage.js'
import { createPrivateKey } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, it, vi } from 'vitest'
import { WorkspaceRegistry } from '../../workspace/workspaces.js'
import { BackgroundTaskStore } from '../background-tasks.js'
import { ProviderCatalog } from '../../providers/catalog.js'
import { RelayPublisher, RelayService, saveRelayConfig } from '../relay.js'

vi.mock('node:crypto', async (original) => ({ ...await original<typeof import('node:crypto')>(), randomUUID: () => '00000000-0000-4000-8000-000000000007' }))

it('preserves main bytes for workspace, background, quota and relay state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'talaria-extra-golden-'))
  const home = join(root, 'agent')
  const stateDir = join(home, 'webui')
  mkdirSync(stateDir, { recursive: true })
  const profileHome = (name: string): string => name === 'default' ? home : join(home, 'profiles', name)
  mkdirSync(profileHome('work'), { recursive: true })
  try {
    const workspaces = new WorkspaceRegistry({ documents: new JsonDocuments(stateDir, profileHome), defaultWorkspace: () => '/test/workspace', profileHome, activeProfile: () => 'default', isRootProfileHome: (value) => value === home, profileConfig: () => ({}) })
    for (const profile of ['default', 'work']) {
      await workspaces.save([{ path: '/test/workspace', name: 'Work' }], profile)
      await workspaces.setLastWorkspace('/test/workspace', profile)
    }
    const background = new BackgroundTaskStore(testSessionDocuments(join(stateDir, 'sessions')), () => 1000)
    await background.update('session', [{ task_id: 'task', kind: 'process', status: 'completed', title: 'Background', result: 'finished' }])
    const catalog = new ProviderCatalog({ documents: new JsonDocuments(stateDir) } as never)
    await catalog.quotaProfileScopeId('default')
    const identity = await testProfileIdentity(home)
    const keyPath = join(stateDir, 'talaria-relay-publisher-0123456789abcdef.pem')
    const pem = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + '11'.repeat(32), 'hex'), format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }).toString()
    await new JsonDocuments(stateDir).put('relay-keys', '0123456789abcdef', pem, null)
    expect(readFileSync(keyPath, 'utf8')).toBe(pem)
    const config = { url: 'https://relay.test', publisher_id: 'https://publisher.test', key_id: 'key', private_key_path: keyPath, private_key_document: '0123456789abcdef', profiles: { default: { identity, profile_id: 'profile' } } }
    await saveRelayConfig(new JsonDocuments(stateDir), config)
    const deps = { stateDir, registry: { activeRuns: new Map([['stream', { session_id: 'session', stream_id: 'stream', started_at: 1000, phase: 'running' }]]) }, presence: { has: () => false }, pending: { approvalPending: () => ({ pending: null }), clarifyPending: () => ({ pending: null }) }, profilesMatch: (a: string, b: string) => a === b, documents: new JsonDocuments(stateDir, profileHome), profileHome, canonicalProfile: (name: string) => name, store: { sessions: new Map(), exists: () => Promise.resolve(false), get: () => Promise.resolve({ session_id: 'session', title: 'Chat', profile: 'default' }) }, now: () => 1000, log: () => undefined } as never
    const publisher = new RelayPublisher(config, deps)
    await publisher.initialize?.()
    await publisher.buildStates('default')
    publisher.stop()
    await new RelayService(deps).clearDeleted('deleted-session', 'default')
    const files: Record<string, string> = {}
    const scan = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) scan(path); else files[relative(root, path)] = path === keyPath ? '[synthetic private key bytes checked above]' : readFileSync(path, 'utf8').replaceAll(root, '<root>') } }
    scan(root)
    expect(files).toMatchSnapshot()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
