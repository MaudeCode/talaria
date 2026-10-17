import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ToolsetsCatalogSchema } from '@maudecode/talaria-web-contracts'
import { expect, it } from 'vitest'
import { bootTestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'

it('serves the profile toolset policy and draft selection without dropping unavailable rows', async () => {
  const sidecar = new FakeSidecar()
  const catalog = { toolsets: [{ name: 'todo', description: 'Tasks', available: false, selected: true, unavailable_reason: 'disabled' as const }], selected_toolsets: ['todo'], using_defaults: false }
  sidecar.respond('toolsets.catalog', (params) => {
    expect(params.enabled_toolsets).toEqual(['todo'])
    expect(params.profile_home).toBe(s.deps.config.hermesHome)
    return catalog
  })
  const s = await bootTestServer({ sidecar })
  try {
    const response = await s.get('/api/toolsets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolsets: ['todo'] }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(catalog)
  } finally { await s.close() }
})

it('scopes a non-owner catalog request to the bound profile and refuses foreign sessions', async () => {
  const sidecar = new FakeSidecar()
  const homes: string[] = []
  sidecar.respond('toolsets.catalog', (params) => {
    homes.push(params.profile_home)
    return { toolsets: [], selected_toolsets: [], using_defaults: true }
  })
  const s = await bootTestServer({ sidecar, env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', HERMES_WEBUI_GROUP_PROFILE_MAP: '{"team":"work"}' } })
  try {
    const foreign = (await s.deps.sessionStore.newSession({ profile: 'default' }))
    const headers = { 'content-type': 'application/json', 'X-Remote-User': 'catalog-user', 'X-Remote-Groups': 'team' }
    const response = await s.get('/api/toolsets', { method: 'POST', headers, body: JSON.stringify({ toolsets: null }) })
    expect(response.status).toBe(200)
    expect(homes).toEqual([s.deps.profileHome('work')])
    const denied = await s.get('/api/toolsets', { method: 'POST', headers, body: JSON.stringify({ toolsets: null, session_id: foreign.session_id }) })
    expect(denied.status).toBe(404)
    expect(homes).toHaveLength(1)
  } finally { await s.close() }
})

it('fails closed when the Agent catalog is unavailable', async () => {
  const s = await bootTestServer({ sidecar: null })
  try {
    const response = await s.get('/api/toolsets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolsets: null }) })
    expect(response.status).toBe(503)
  } finally { await s.close() }
})

it('validates the shared iOS/Web catalog fixture', () => {
  const fixture: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/toolsets.json'), 'utf8'))
  expect(ToolsetsCatalogSchema.parse(fixture).toolsets[1]?.available).toBe(false)
})
