import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseProviderQualifiedModel } from '../config/agent-config.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { splitPickerOverflow } from './catalog.js'
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

  beforeAll(async () => {
    const sidecar = new FakeSidecar()
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
    expect(catalog).toMatchObject({ default_model: '@custom:localhost:8080:m', default_provider_id: 'custom:localhost:8080', default_bare_id: 'm' })
  })

  it('stamps /api/providers model lists with the card provider', async () => {
    const rows = ((await (await s.get('/api/providers')).json()) as Json).providers as { id: string; models: Entry[] }[]
    const ollama = rows.find((r) => r.id === 'ollama')
    expect(ollama?.models).toContainEqual(expect.objectContaining({ id: 'llama3:8b', provider_id: 'ollama', bare_id: 'llama3:8b' }))
    for (const row of rows) for (const m of row.models) expect(m.provider_id).toBe(parseProviderQualifiedModel(m.id)?.[1] ?? row.id)
  })

  it('stamps /api/models/live entries with the echoed provider', async () => {
    const live = (await (await s.get('/api/models/live?provider=gemini')).json()) as { provider: string; models: Entry[] }
    expect(live.provider).toBe('gemini')
    expect(live.models).toContainEqual(expect.objectContaining({ id: 'gemini-2.5-flash', provider_id: 'gemini', bare_id: 'gemini-2.5-flash' }))
  })
})
