import { useJsonStorage } from '../test/storage.js'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { writeEnvFile } from '../test/env-file.js'

useJsonStorage()

type Json = Record<string, unknown>
interface Entry { id: string; provider_id: string; bare_id: string; favorite?: boolean }
interface Catalog { favorites?: { provider_id: string; model: string }[] | null; groups: { provider_id: string; models: Entry[] }[] }

const profileRow = (name: string, path: string) => ({ name, path, is_default: name === 'default', gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 })

/** TAL-1857: model favorites are stored per profile on the server and resolved onto the picker catalog. */
describe('model favorites', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  const ids: Record<string, string[]> = { anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6', 'shared-model'], openrouter: ['shared-model'] }
  let cookie = ''

  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
  const catalog = async (headers: Record<string, string> = {}): Promise<Catalog> => (await (await s.get('/api/models', { headers })).json()) as Catalog
  const star = async (provider_id: string, model: string, favorite: boolean, headers: Record<string, string> = {}): Promise<Json> => {
    const res = await post('/api/models/favorite', { provider_id, model, favorite }, headers)
    expect(res.status).toBe(200)
    return (await res.json()) as Json
  }
  const starred = (c: Catalog): string[] => c.groups.flatMap((g) => g.models.filter((m) => m.favorite).map((m) => `${m.provider_id}/${m.bare_id}`))
  const flags = (c: Catalog): boolean[] => c.groups.flatMap((g) => g.models.map((m) => m.favorite ?? false))

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    const configs = new Map<string, Json>()
    sidecar.respond('config.get', (params) => {
      const path = join(params.profile_home, 'config.yaml')
      return existsSync(path) ? { path, exists: true, config: configs.get(params.profile_home) ?? {} } : { path, exists: false, config: {} }
    })
    sidecar.respond('providers.model_ids', (params) => ({ provider: params.provider, model_ids: ids[params.provider] ?? [], fallback: !(params.provider in ids) }))
    sidecar.respond('providers.auth_status', (params) => ({ status: { logged_in: false, provider: params.provider ?? '', error: 'not logged in' } }))
    const work = join(s.state, 'profiles', 'work')
    for (const home of [s.state, work]) {
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'config.yaml'), '# seed\n')
      configs.set(home, { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' } })
      writeEnvFile(join(home, '.env'), { ANTHROPIC_API_KEY: 'sk-ant-test-1234', OPENROUTER_API_KEY: 'sk-or-test-1234' })
    }
    sidecar.respond('profiles.list', () => ({ profiles: [profileRow('default', s.state), profileRow('work', work)] }))
    s.deps.profiles.invalidate()
    cookie = ((await post('/api/profile/switch', { name: 'work' })).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    // The switch above set no cookie for the default client, which stays on `default`.
  })
  afterAll(() => s.close())

  it('round-trips stars through the catalog in starred order, on that provider and model pair only', async () => {
    const before = await catalog()
    expect(before.favorites).toBeNull()
    expect(flags(before).every((f) => !f)).toBe(true)
    // The same bare id ships under both providers.
    expect(before.groups.find((g) => g.provider_id === 'openrouter')?.models.map((m) => m.bare_id)).toContain('shared-model')

    await star('anthropic', 'shared-model', true)
    expect((await star('anthropic', 'claude-opus-4-7', true)).favorites).toEqual([{ provider_id: 'anthropic', model: 'shared-model' }, { provider_id: 'anthropic', model: 'claude-opus-4-7' }])
    let after = await catalog()
    expect(after.favorites).toEqual([{ provider_id: 'anthropic', model: 'shared-model' }, { provider_id: 'anthropic', model: 'claude-opus-4-7' }])
    expect(starred(after).sort()).toEqual(['anthropic/claude-opus-4-7', 'anthropic/shared-model'])
    expect(after.groups.find((g) => g.provider_id === 'openrouter')?.models.find((m) => m.bare_id === 'shared-model')?.favorite).toBe(false)

    // Starring again keeps its place; unstarring removes it and leaves an empty list, not `null`.
    await star('anthropic', 'shared-model', true)
    expect((await catalog()).favorites?.[0]).toEqual({ provider_id: 'anthropic', model: 'shared-model' })
    await star('anthropic', 'shared-model', false)
    after = await catalog()
    expect(after.favorites).toEqual([{ provider_id: 'anthropic', model: 'claude-opus-4-7' }])
    expect(starred(after)).toEqual(['anthropic/claude-opus-4-7'])
    await star('anthropic', 'claude-opus-4-7', false)
    expect((await catalog()).favorites).toEqual([])
  })

  it('keeps both of two concurrent single-model writes', async () => {
    await Promise.all([star('anthropic', 'claude-opus-4-7', true), star('openrouter', 'shared-model', true)])
    const after = await catalog()
    expect(after.favorites).toHaveLength(2)
    expect(starred(after).sort()).toEqual(['anthropic/claude-opus-4-7', 'openrouter/shared-model'])
    await Promise.all([star('anthropic', 'claude-opus-4-7', false), star('openrouter', 'shared-model', false)])
    expect((await catalog()).favorites).toEqual([])
  })

  it('imports only while the profile has never saved favorites, and isolates profiles', async () => {
    const headers = { cookie }
    expect((await catalog(headers)).favorites).toBeNull()
    const list = [{ provider_id: 'anthropic', model: 'claude-sonnet-4-6' }, { provider_id: 'openrouter', model: 'shared-model' }]
    let res = await post('/api/models/favorites/import', { favorites: [...list, list[0]] }, headers)
    expect(await res.json()).toEqual({ ok: true, imported: true, favorites: list })
    res = await post('/api/models/favorites/import', { favorites: [{ provider_id: 'anthropic', model: 'claude-opus-4-7' }] }, headers)
    expect(await res.json()).toEqual({ ok: true, imported: false, favorites: list })
    const work = await catalog(headers)
    expect(work.favorites).toEqual(list)
    expect(starred(work).sort()).toEqual(['anthropic/claude-sonnet-4-6', 'openrouter/shared-model'])

    // `default` saved (and cleared) favorites above, so its stored value is `[]` and an import there changes nothing.
    expect((await catalog()).favorites).toEqual([])
    res = await post('/api/models/favorites/import', { favorites: list })
    expect(await res.json()).toEqual({ ok: true, imported: false, favorites: [] })
    expect(flags(await catalog()).every((f) => !f)).toBe(true)
    // `/api/settings` never exposes the per-profile store.
    expect(await (await s.get('/api/settings')).json()).not.toHaveProperty('model_favorites_by_profile')
  })

  it('keeps a favorite whose model left the catalog and shows it again when the model returns', async () => {
    await star('anthropic', 'claude-opus-4-7', true)
    ids.anthropic = ['claude-sonnet-4-6', 'shared-model']
    await post('/api/models/refresh', { provider: 'anthropic' })
    let after = await catalog()
    expect(after.favorites).toEqual([{ provider_id: 'anthropic', model: 'claude-opus-4-7' }])
    expect(starred(after)).toEqual([])
    ids.anthropic = ['claude-opus-4-7', 'claude-sonnet-4-6', 'shared-model']
    await post('/api/models/refresh', { provider: 'anthropic' })
    after = await catalog()
    expect(starred(after)).toEqual(['anthropic/claude-opus-4-7'])
  })

  it('refuses a malformed write', async () => {
    expect((await post('/api/models/favorite', { provider_id: '', model: 'x', favorite: true })).status).toBe(400)
    expect((await post('/api/models/favorite', { provider_id: 'anthropic', model: 'x' })).status).toBe(400)
  })
})
