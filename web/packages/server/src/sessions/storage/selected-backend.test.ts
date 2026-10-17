import { ProfileService } from '../../profiles/profiles.js'
import { profileIdentity } from '../relay.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bootTestServer, type BootOptions } from '../../test/harness.js'
import { RevisionConflict, type DocumentBackend, type StoredDocument } from './backend.js'
import { JsonStorage } from './json.js'

function memoryDocuments(): DocumentBackend {
  // This test-owned port has no filesystem; the JSON adapter cannot prove runtime injection by itself.
  const namespaces = new Map<string, Map<string, StoredDocument>>()
  let sequence = 0
  return {
    get: (namespace, key) => Promise.resolve(structuredClone(namespaces.get(namespace)?.get(key) ?? null)),
    put: (namespace, key, value, expected) => {
      let records = namespaces.get(namespace)
      if (!records) { records = new Map(); namespaces.set(namespace, records) }
      if ((records.get(key)?.revision ?? null) !== expected) return Promise.reject(new RevisionConflict(`${namespace}/${key}`))
      const revision = `revision-${String(++sequence)}`
      records.set(key, { value: structuredClone(value), revision })
      return Promise.resolve(revision)
    },
    delete: (namespace, key, expected) => {
      const records = namespaces.get(namespace)
      if (expected !== undefined && (records?.get(key)?.revision ?? null) !== expected) return Promise.reject(new RevisionConflict(`${namespace}/${key}`))
      return Promise.resolve(records?.delete(key) ?? false)
    },
    list: (namespace) => Promise.resolve([...(namespaces.get(namespace) ?? [])].map(([key, record]) => ({ key, revision: record.revision }))),
  }
}

it('uses the selected document backend for runtime reads and mutations without local document files', async () => {
  const documents = memoryDocuments()
  await documents.put('settings', 'settings', { theme: 'light' }, null)
  const options: BootOptions = {
    env: { HERMES_WEBUI_TEST_NETWORK_BLOCK: '1' },
    storage: (config) => {
      const json = new JsonStorage({ directory: config.sessionDir, now: () => 1000, stampingSince: () => 0 })
      return { kind: 'test-documents', sessions: json.sessions, journals: json.journals, documents, close: () => json.close() }
    },
  }
  const server = await bootTestServer(options)
  try {
    const settings = await (await server.get('/api/settings')).json() as { theme: string }
    expect(settings.theme).toBe('light')
    const session = await server.deps.sessionStore.newSession()
    await server.deps.sessionStore.deps.drafts.write(session.session_id, { text: 'remote draft', files: [] }, '1000')
    await server.deps.projects.mutate((projects) => { projects.push({ project_id: 'project', name: 'Remote', profile: 'default' }) })
    await server.deps.settings.save({ theme: 'dark' })
    expect((await documents.get('settings', 'settings'))?.value).toMatchObject({ theme: 'dark' })
    expect((await documents.get('drafts', session.session_id))?.value).toMatchObject({ text: 'remote draft', _draft_version: '1000' })
    expect((await documents.get('projects', 'projects'))?.value).toEqual([{ project_id: 'project', name: 'Remote', profile: 'default' }])
    for (const file of ['settings.json', 'projects.json', '.signing_key', 'recovery_stamping_since', `sessions/_drafts/${session.session_id}.json`]) expect(existsSync(join(server.state, file))).toBe(false)
  } finally { await server.close() }
})

it('removes backend-owned profile identity and workspace trust before a deleted profile can be recreated', async () => {
  const state = mkdtempSync(join(tmpdir(), 'talaria-profile-documents-'))
  const home = join(state, 'profiles', 'work')
  mkdirSync(home, { recursive: true })
  const documents = memoryDocuments()
  const oldIdentity = `pfi_${'a'.repeat(32)}`
  await documents.put('relay-identities', 'work', oldIdentity + '\n', null)
  await documents.put('workspaces', 'work.registry', [{ path: '/old/trusted', name: 'Old' }], null)
  await documents.put('workspaces', 'work.last', '/old/trusted', null)
  const profiles = new ProfileService({ documents, baseHome: state, isolatedProfileMode: () => false, streamsActive: () => false, profileRunsActive: () => false, profileHome: () => home, sidecar: () => ({ call: (method: string) => { if (method === 'profiles.list') return Promise.resolve({ profiles: [] }); rmSync(home, { recursive: true }); return Promise.resolve({ ok: true }) } }), log: () => undefined } as never)
  try {
    await profiles.initialize()
    await profiles.delete('work', 'default')
    expect(await documents.get('relay-identities', 'work')).toBeNull()
    expect(await documents.get('workspaces', 'work.registry')).toBeNull()
    expect(await documents.get('workspaces', 'work.last')).toBeNull()
    expect(await profiles.beginWrite('work')).toBe('missing')
    mkdirSync(home, { recursive: true })
    expect(await profileIdentity({ documents, profileHome: () => home }, 'work')).not.toBe(oldIdentity)
  } finally { rmSync(state, { recursive: true, force: true }) }
})
