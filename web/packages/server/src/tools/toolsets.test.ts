import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ToolsetsCatalogSchema } from '@maudecode/talaria-web-contracts'
import { expect, it } from 'vitest'
import { bootTestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'

it('serves the profile toolset policy and draft selection without dropping unavailable rows', async () => {
  const sidecar = new FakeSidecar()
  const catalog = { toolsets: [
    { name: 'todo', description: 'Tasks', available: false, selected: true, unavailable_reason: 'disabled' as const, group: 'not_available' as const },
    { name: 'web', description: 'Web', available: true, selected: false, unavailable_reason: null, stripped_tools: ['web_search'], stripped_by: ['search'], group: 'available' as const },
  ], selected_toolsets: ['todo'], using_defaults: false, default_toolsets: ['web'] }
  sidecar.respond('toolsets.catalog', (params) => {
    expect(params.enabled_toolsets).toEqual(['todo'])
    expect(params.profile_home).toBe(s.deps.config.hermesHome)
    return catalog
  })
  const s = await bootTestServer({ sidecar })
  try {
    const response = await s.get('/api/toolsets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolsets: ['todo'] }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...catalog, toolsets: [{ ...catalog.toolsets[1], can_deselect: true }, { ...catalog.toolsets[0], can_deselect: false }] })
  } finally { await s.close() }
})

it('searches and orders the rows for the menu, and reports the profile defaults beside an explicit choice (TAL-2144)', async () => {
  const sidecar = new FakeSidecar()
  const row = (name: string, description: string, available: boolean) => ({ name, description, available, selected: false, unavailable_reason: available ? null : 'unavailable' as const, group: available ? 'available' as const : 'not_available' as const })
  // The sidecar's order: alphabetical, availability mixed.
  const rows = [row('browser', 'Drive a browser', false), row('file', 'Read and write files', true), row('todo', 'Task lists', false), row('web', 'Search the web', true)]
  sidecar.respond('toolsets.catalog', (params) => ({ toolsets: rows, selected_toolsets: params.enabled_toolsets ?? ['file'], using_defaults: params.enabled_toolsets === null, default_toolsets: ['file'] }))
  const s = await bootTestServer({ sidecar })
  const read = async (body: object) => {
    const response = await s.get('/api/toolsets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    const catalog = ToolsetsCatalogSchema.parse(await response.json())
    return { names: catalog.toolsets.map((item) => item.name), defaults: catalog.default_toolsets, canDeselect: Object.fromEntries(catalog.toolsets.map((item) => [item.name, item.can_deselect])) }
  }
  try {
    expect(await read({ toolsets: ['web'] })).toEqual({ names: ['file', 'web', 'browser', 'todo'], defaults: ['file'], canDeselect: { file: true, web: false, browser: false, todo: false } })
    expect((await read({ toolsets: null, q: '' })).names).toEqual(['file', 'web', 'browser', 'todo'])
    expect((await read({ toolsets: null, q: '  BROWSER ' })).names).toEqual(['browser'])
    // `file` matches by its description, `browser` by its name; the available ones still come first.
    expect((await read({ toolsets: ['web'], q: 'W' })).names).toEqual(['file', 'web', 'browser'])
    expect((await read({ toolsets: null, q: 'nothing like it' })).names).toEqual([])
    // Search must not turn a multi-selection into the last selected row.
    for (const [toolsets, q, expected] of [
      [['file'], 'file', { file: false }],
      [['file', 'web'], 'file', { file: true }],
      [null, 'file', { file: false }],
      [['file'], 'web', { web: true }],
      [['file', 'web'], 'browser', { browser: false }],
    ] as const) {
      expect((await read({ toolsets, q })).canDeselect).toEqual(expected)
    }
  } finally { await s.close() }
})

it('scopes a non-owner catalog request to the bound profile and refuses foreign sessions', async () => {
  const sidecar = new FakeSidecar()
  const homes: string[] = []
  sidecar.respond('toolsets.catalog', (params) => {
    homes.push(params.profile_home)
    return { toolsets: [], selected_toolsets: [], using_defaults: true, default_toolsets: [] }
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
