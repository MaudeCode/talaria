import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ToolsetsCatalogSchema } from '@maudecode/talaria-web-contracts'
import { expect, it, vi } from 'vitest'
import { bootTestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'

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
      // TAL-2282: a chosen toolset that is unavailable now can still be dropped.
      [['file', 'browser'], 'browser', { browser: true }],
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
  const s = await bootTestServer({ sidecar, env: { TALARIA_WEB_TRUSTED_AUTH_HEADER: 'X-Remote-User', TALARIA_WEB_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', TALARIA_WEB_GROUP_PROFILE_MAP: '{"team":"work"}' } })
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

it('reads the profile default toolsets and saves them under the config.yaml lock (TAL-2282)', async () => {
  const sidecar = new FakeSidecar()
  const row = (name: string, on: boolean, available = true) => ({ name, description: name, available, selected: on, unavailable_reason: available ? null : 'unavailable' as const, group: available ? 'available' as const : 'not_available' as const })
  let defaults = ['file']
  const catalog = () => ({ toolsets: [row('missing', false, false), row('file', defaults.includes('file')), row('talaria', defaults.includes('talaria'))], selected_toolsets: defaults, using_defaults: true, default_toolsets: defaults })
  const order: string[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  sidecar.respond('toolsets.defaults', () => catalog())
  sidecar.respond('toolsets.set_default', async (params) => {
    if (params.name === 'synthetic-mcp') throw new SidecarError('unknown toolset: synthetic-mcp', { code: -32602, condition: 'invalid_params' })
    order.push('save:start')
    await held
    defaults = params.enabled ? [...defaults, params.name] : defaults.filter((name) => name !== params.name)
    order.push('save:end')
    return catalog()
  })
  sidecar.respond('config.get', (params) => ({ path: params.config_path ?? join(params.profile_home, 'config.yaml'), exists: true, config: {} }))
  sidecar.respond('config.set', (params) => { order.push('other-write'); return { ok: true as const, path: params.config_path } })
  const s = await bootTestServer({ sidecar })
  const put = (name: string, enabled: boolean) => s.get('/api/toolsets/defaults', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, enabled }) })
  const view = async (response: Response) => {
    expect(response.status).toBe(200)
    const parsed = ToolsetsCatalogSchema.parse(await response.json())
    return { defaults: parsed.default_toolsets, rows: parsed.toolsets.map((item) => [item.name, item.selected, item.can_deselect]) }
  }
  try {
    expect(await view(await s.get('/api/toolsets/defaults'))).toEqual({ defaults: ['file'], rows: [['file', true, false], ['talaria', false, true], ['missing', false, false]] })
    const saving = put('talaria', true)
    await vi.waitFor(() => { expect(order).toEqual(['save:start']) })
    // Another config.yaml write for the same profile waits for the save.
    const other = s.deps.agentConfig.update(s.deps.config.hermesHome, (config) => { config.marker = true })
    // Its read and write answer from this process's fake in microtasks, so one loop turn would finish an unheld write.
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(order).toEqual(['save:start'])
    release()
    expect(await view(await saving)).toEqual({ defaults: ['file', 'talaria'], rows: [['file', true, true], ['talaria', true, true], ['missing', false, false]] })
    await other
    expect(order).toEqual(['save:start', 'save:end', 'other-write'])
    const refused = await put('synthetic-mcp', true)
    expect(refused.status).toBe(400)
  } finally { await s.close() }
})
