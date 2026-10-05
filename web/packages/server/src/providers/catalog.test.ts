import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseProviderQualifiedModel } from '../config/agent-config.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { repairSessionModel, splitPickerOverflow, type ModelEntry, type ModelsCatalog } from './catalog.js'
import { writeEnvFile } from './env-file.js'

type Json = Record<string, unknown>
interface Entry { id: string; provider_id?: string; bare_id?: string }
interface Group { provider_id: string; models: Entry[]; extra_models?: Entry[] }

describe('parseProviderQualifiedModel, the one `@provider:model` splitter', () => {
  it('splits a known provider at its first colon so the model keeps its own colons', () => {
    expect(parseProviderQualifiedModel('@ollama:llama3:8b')).toEqual(['llama3:8b', 'ollama'])
    expect(parseProviderQualifiedModel('@gemini:gemini-2.5-flash')).toEqual(['gemini-2.5-flash', 'gemini'])
  })

  it('keeps a `custom:` host:port as the provider', () => {
    expect(parseProviderQualifiedModel('@custom:localhost:8080:m')).toEqual(['m', 'custom:localhost:8080'])
    expect(parseProviderQualifiedModel('@custom:my-box:llama3:8b')).toEqual(['llama3:8b', 'custom:my-box'])
  })

  it('falls back to the first colon for an unknown provider, and leaves unqualified ids alone', () => {
    expect(parseProviderQualifiedModel('@fake-sub:claude:latest')).toEqual(['claude:latest', 'fake-sub'])
    expect(parseProviderQualifiedModel('llama3:8b')).toBeNull()
    expect(parseProviderQualifiedModel('@cf/meta/llama-3')).toBeNull()
  })
})

describe('stale session model repair (TAL-542)', () => {
  const catalog = (active: string, defaultModel: string, groups: Record<string, string[]>, extra: Record<string, string[]> = {}): ModelsCatalog => {
    const entries = (pid: string, ids: string[]): ModelEntry[] => ids.map((id) => { const [bare, provider] = parseProviderQualifiedModel(id) ?? [id, pid]; return { id, label: id, bare_id: bare, provider_id: provider } })
    return {
      active_provider: active, default_model: defaultModel, default_provider_id: active, default_bare_id: defaultModel, aliases: {}, configured_model_badges: {},
      groups: Object.entries(groups).map(([pid, ids]) => ({ provider: pid, provider_id: pid, models: entries(pid, ids), ...(extra[pid] ? { extra_models: entries(pid, extra[pid]) } : {}) })),
    }
  }
  const kilo = 'kilo/minimax/minimax-m3'

  it('moves a pair to the only other provider listing the model, matching its spelling (#5731)', () => {
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: [`@kilocode:${kilo}`] }), kilo, 'ollama')).toEqual([kilo, 'kilocode'])
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: ['GPT.4O.MINI'] }), 'gpt-4o-mini', 'ollama')).toEqual(['GPT.4O.MINI', 'kilocode'])
  })

  it('finds the owner with a vendor prefix on either side and starts on the owner\'s own id', () => {
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: ['openai/gpt-5.4'] }), 'gpt-5.4', 'ollama')).toEqual(['openai/gpt-5.4', 'kilocode'])
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: ['gpt-5.4'] }), 'openai/gpt-5.4', 'ollama')).toEqual(['gpt-5.4', 'kilocode'])
    // The profile's own provider listing the vendorless id: the session starts on that id rather than the default.
    expect(repairSessionModel(catalog('openai-codex', 'gpt-5.5', { 'openai-codex': ['gpt-5.5', 'gpt-5.4-mini'] }), 'openai/gpt-5.4-mini', 'openai-codex')).toEqual(['gpt-5.4-mini', 'openai-codex'])
  })

  it('starts a bare model on the vendor-prefixed id its own provider advertises', () => {
    expect(repairSessionModel(catalog('openrouter', 'openai/gpt-5.5', { openrouter: ['openai/gpt-5.5', 'openai/gpt-5.4'] }), 'gpt-5.4', 'openrouter')).toEqual(['openai/gpt-5.4', 'openrouter'])
    expect(repairSessionModel(catalog('ollama', 'llama3.2', { ollama: ['lmstudio-community/Qwen2.5-Coder'] }), 'Qwen2.5-Coder', 'ollama')).toBeNull()
  })

  it('never treats a namespace other than a vendor prefix as the same model', () => {
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: ['Qwen2.5-Coder'] }), 'lmstudio-community/Qwen2.5-Coder', 'ollama')).toBeNull()
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: ['lmstudio-community/Qwen2.5-Coder'] }), 'Qwen2.5-Coder', 'ollama')).toBeNull()
  })

  it('keeps the pair without one clear owner or when its provider lists it, in models or extra_models', () => {
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: [kilo], other: [kilo] }), kilo, 'ollama')).toBeNull()
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'] }), kilo, 'ollama')).toBeNull()
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { kilocode: [kilo] }), kilo, 'ollama')).toBeNull()
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: [kilo], kilocode: [kilo] }), kilo, 'ollama')).toBeNull()
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: [kilo] }, { ollama: [kilo] }), kilo, 'ollama')).toBeNull()
  })

  it('keeps the pair when its provider\'s or the only owner\'s live lookup failed, or it is the profile\'s own provider', () => {
    const c = catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: [kilo] })
    expect(repairSessionModel(c, kilo, 'ollama', new Set(['ollama']))).toBeNull()
    expect(repairSessionModel(c, kilo, 'ollama', new Set(['kilocode']))).toBeNull()
    expect(repairSessionModel(catalog('ollama', 'llama3.2', { ollama: ['llama3.2'], kilocode: [kilo] }), kilo, 'ollama')).toBeNull()
  })

  it('switches a model naming another vendor to the profile default, and keeps unknown vendors (#1734, #751)', () => {
    const codex = catalog('openai-codex', 'gpt-5.5', { 'openai-codex': ['gpt-5.5'] })
    for (const stale of ['gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview', 'openai/gpt-5.4-mini', 'claude-sonnet-4']) expect(repairSessionModel(codex, stale, null)).toEqual(['gpt-5.5', 'openai-codex'])
    for (const kept of ['gpt-5.4-mini', 'custom-provider/test-model-999', 'lmstudio-community/Qwen2.5-Coder-7B-Instruct-GGUF', 'custom/my-local-llm']) expect(repairSessionModel(codex, kept, null)).toBeNull()
    expect(repairSessionModel(catalog('openrouter', 'openai/gpt-5.4-mini', { openrouter: ['anthropic/claude-sonnet-4'] }), 'google/gemini-3.1-pro-preview', null)).toBeNull()
    expect(repairSessionModel(catalog('anthropic', 'claude-sonnet-4', { anthropic: ['claude-sonnet-4'] }), 'gpt-5.4-mini', 'anthropic')).toEqual(['claude-sonnet-4', 'anthropic'])
    expect(repairSessionModel(catalog('anthropic', '', { anthropic: ['claude-sonnet-4'] }), 'gpt-5.4-mini', null)).toBeNull()
  })

  it('prefers a provider that lists a providerless model over the default', () => {
    expect(repairSessionModel(catalog('openai-codex', 'gpt-5.5', { 'openai-codex': ['gpt-5.5'], gemini: ['gemini-3.1-pro-preview'] }), 'gemini-3.1-pro-preview', null)).toEqual(['gemini-3.1-pro-preview', 'gemini'])
  })
})

describe('the picker overflow split', () => {
  it('keeps a colon-bearing selected model visible', () => {
    const models = Array.from({ length: 30 }, (_, i) => ({ id: `m${String(i)}`, label: `M${String(i)}` }))
    const [visible, extras] = splitPickerOverflow(models, '@custom:localhost:8080:m20', 'custom:localhost:8080')
    expect(visible.map((m) => m.id)).toContain('m20')
    expect(extras.map((m) => m.id)).not.toContain('m20')
  })
})

/** TAL-301: every `/api/models` and `/api/providers` entry carries the server's split of its id. */
describe('catalog entries carry their routing provider and bare id', () => {
  let s: TestServer
  let sidecar: FakeSidecar

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    writeEnvFile(join(s.state, '.env'), { ANTHROPIC_API_KEY: 'sk-ant-test-1234', GOOGLE_API_KEY: 'g-test-1234', GEMINI_API_KEY: 'g-test-5678' })
    const config = {
      model: { default: '@custom:localhost:8080:m', provider: 'anthropic' },
      providers: { ollama: { base_url: 'http://localhost:11434/v1', models: ['llama3:8b'] } },
    }
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: existsSync(join(p.profile_home, 'config.yaml')), config }))
    sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
    sidecar.respond('plugins.providers', () => ({ providers: [] }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: [] }))
  })
  afterAll(() => s.close())

  it('stamps /api/models entries and the default with `parseProviderQualifiedModel` output', async () => {
    const catalog = (await (await s.get('/api/models')).json()) as Json
    const groups = catalog.groups as Group[]
    const entries = groups.flatMap((g) => [...g.models, ...(g.extra_models ?? [])].map((e) => ({ group: g.provider_id, ...e })))
    for (const e of entries) {
      const [bare, provider] = parseProviderQualifiedModel(e.id) ?? [e.id, e.group]
      expect({ id: e.id, provider_id: e.provider_id, bare_id: e.bare_id }).toEqual({ id: e.id, provider_id: provider, bare_id: bare })
    }
    const byId = (id: string): Entry | undefined => entries.find((e) => e.id === id)
    expect(byId('@ollama:llama3:8b')).toMatchObject({ provider_id: 'ollama', bare_id: 'llama3:8b' })
    expect(byId('@custom:localhost:8080:m')).toMatchObject({ provider_id: 'custom:localhost:8080', bare_id: 'm' })
    expect(byId('@gemini:gemini-2.5-flash')).toMatchObject({ provider_id: 'gemini', bare_id: 'gemini-2.5-flash' })
    expect(byId('@google:gemini-2.5-flash')).toMatchObject({ provider_id: 'google', bare_id: 'gemini-2.5-flash' })
    expect(byId('claude-opus-4.7')).toMatchObject({ provider_id: 'anthropic', bare_id: 'claude-opus-4.7' })
    expect(catalog).toMatchObject({ default_model: '@custom:localhost:8080:m', default_provider_id: 'custom:localhost:8080', default_bare_id: 'm', default_option_id: '@custom:localhost:8080:m' })
  })

  it('stamps /api/providers model lists with the card provider', async () => {
    const rows = ((await (await s.get('/api/providers')).json()) as Json).providers as { id: string; models: Entry[] }[]
    const ollama = rows.find((r) => r.id === 'ollama')
    expect(ollama?.models).toContainEqual(expect.objectContaining({ id: 'llama3:8b', provider_id: 'ollama', bare_id: 'llama3:8b' }))
    for (const row of rows) for (const m of row.models) expect(m.provider_id).toBe(parseProviderQualifiedModel(m.id)?.[1] ?? row.id)
  })

  it('session payloads carry the catalog entry their stored pair selects', async () => {
    const post = async (path: string, body: Json): Promise<Json> => (await (await s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })).json()) as Json
    const sid = String(((await post('/api/session/new', {})).session as Json).session_id)
    const cases: [Json, string | null][] = [
      [{ model: '@ollama:llama3:8b', model_provider: 'ollama' }, '@ollama:llama3:8b'],
      [{ model: '@custom:localhost:8080:m', model_provider: 'custom:localhost:8080' }, '@custom:localhost:8080:m'],
      [{ model: 'gemini-2.5-flash', model_provider: 'google' }, '@google:gemini-2.5-flash'],
      [{ model: 'gemini-2.5-flash', model_provider: 'gemini' }, '@gemini:gemini-2.5-flash'],
      [{ model: 'not-in-catalog', model_provider: 'ollama' }, null],
    ]
    for (const [body, optionId] of cases) {
      const updated = (await post('/api/session/update', { session_id: sid, ...body })).session as Json
      expect(updated.model_option_id, JSON.stringify(body)).toBe(optionId)
      const detail = ((await (await s.get(`/api/session?session_id=${sid}`)).json()) as Json).session as Json
      expect(detail.model_option_id, JSON.stringify(body)).toBe(optionId)
    }
  })

  it('a catalog invalidation drops the option ids it paired against', async () => {
    await s.get('/api/models')
    expect(s.deps.catalog.modelOptionFor(s.state, 'llama3:8b', 'ollama')).toBe('@ollama:llama3:8b')
    s.deps.catalog.invalidate(s.state)
    expect(s.deps.catalog.modelOptionFor(s.state, 'llama3:8b', 'ollama')).toBeNull()
    await s.deps.catalog.warmModelOptions(s.state)
    expect(s.deps.catalog.modelOptionFor(s.state, 'llama3:8b', 'ollama')).toBe('@ollama:llama3:8b')
  })

  it('cron job payloads carry the catalog entry their stored pair selects', async () => {
    const jobs = new Map<string, Json>()
    sidecar.respond('cron.list', () => ({ jobs: [...jobs.values()] as never[] }))
    sidecar.respond('cron.create', (params) => { const job = { id: `c${String(jobs.size + 1)}`, name: null, profile: null, toast_notifications: true, monitor: '', continuity: false, ...(params.job as Json), context_from: [] }; jobs.set(job.id, job); return { job: job } })
    const create = async (body: Json): Promise<Json> => ((await (await s.get('/api/crons/create', { method: 'POST', body: JSON.stringify({ schedule: 'every 1h', prompt: 'hi', ...body }), headers: { 'content-type': 'application/json' } })).json()) as Json).job as Json
    expect(await create({ model: '@ollama:llama3:8b' })).toMatchObject({ model: 'llama3:8b', provider: 'ollama', model_option_id: '@ollama:llama3:8b' })
    expect(await create({ model: 'gemini-2.5-flash', provider: 'google' })).toMatchObject({ model_option_id: '@google:gemini-2.5-flash' })
    expect(await create({ model: 'gemini-2.5-flash' })).toMatchObject({ model_option_id: null })
    const listed = ((await (await s.get('/api/crons')).json()) as Json).jobs as Json[]
    expect(listed.map((j) => j.model_option_id)).toEqual(['@ollama:llama3:8b', '@google:gemini-2.5-flash', null])
  })

  it('stamps /api/models/live entries with the echoed provider', async () => {
    const live = (await (await s.get('/api/models/live?provider=gemini')).json()) as { provider: string; models: Entry[] }
    expect(live.provider).toBe('gemini')
    expect(live.models).toContainEqual(expect.objectContaining({ id: 'gemini-2.5-flash', provider_id: 'gemini', bare_id: 'gemini-2.5-flash' }))
  })
})
