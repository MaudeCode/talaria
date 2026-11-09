import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { Session } from './session.js'

type Json = Record<string, unknown>
const FIXTURE = join(import.meta.dirname, '../../../contracts/fixtures/sidecar/usage-read.json')
const NOW = Date.parse('2026-11-09T12:00:00Z') / 1000
const CALLER = '20261109_090000_caller'
const ZAI_CALLER = '20261109_090000_zai'
/** Each recorded call; `RECORD_TAL1973=1` rewrites the fixture from this run. */
const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<'server.usage_read', { params: Json; result: Json }[]>
const record = (index: number, params: Json, result: Json | undefined) => {
  if (process.env.RECORD_TAL1973) { recorded['server.usage_read'][index] = { params, result: result! }; writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`) }
  expect(recorded['server.usage_read'][index]).toEqual({ params, result })
}

describe('usage_read (TAL-1973)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let config: Json
  const read = async (caller = CALLER) => {
    const reply = await sidecar.serverRequest('server.usage_read', { caller_session_id: caller })
    return 'error' in reply ? { error: reply.error.data } : { result: reply.result as Json }
  }
  const seed = (provider: string, sid = CALLER) => s.deps.sessionStore.save(new Session({
    session_id: sid, title: 'Long task', profile: 'default', model: 'claude-sonnet-4-6', model_provider: provider, updated_at: 1,
    input_tokens: 123_456, output_tokens: 7_890, cache_read_tokens: 98_765, estimated_cost: 1.234,
    context_length: 200_000, threshold_tokens: 160_000, last_prompt_tokens: 50_000,
    messages: [{ role: 'user', content: 'Start' }, { role: 'assistant', content: 'Started' }, { role: 'user', content: 'Go on' }, { role: 'assistant', content: 'Done' }],
  }, { workspace: s.state, model: null }))
  const accountReads = () => sidecar.calls.filter((c) => c.method === 'usage.account').length

  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, now: () => NOW })
    config = { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' }, providers: { anthropic: { api_key: 'sk-ant-api03-synthetic-usage-read-key' } } }
    sidecar.respond('config.get', (params) => {
      const path = join(params.profile_home, 'config.yaml')
      return existsSync(path) ? { path, exists: true, config } : { path, exists: false, config: {} }
    })
    mkdirSync(s.state, { recursive: true })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    writeFileSync(join(s.state, '.quota_scope_id'), `${'0'.repeat(31)}1\n`)
    sidecar.respond('providers.model_ids', (params) => ({ provider: params.provider, model_ids: [] }))
    sidecar.respond('providers.auth_status', (params) => ({ status: { logged_in: false, provider: params.provider ?? '', error: 'not logged in' } }))
    // Read three minutes before NOW; the session window resets in 2h 5m.
    sidecar.respond('usage.account', (params) => ({ snapshot: { provider: params.provider, available: true, title: 'Claude limits', plan: 'max', fetched_at: '2026-11-09T11:57:00Z', details: [], windows: [
      { label: 'Session', used_percent: 42.4, reset_at: '2026-11-09T14:05:00Z' },
      { label: 'Weekly', used_percent: 61, reset_at: '2026-11-12T12:00:00Z' },
    ] } }))
  })
  afterEach(() => s.close())

  it("answers the caller's usage as /api/session/usage and the session row report it, and its provider's cached sidebar windows", async () => {
    await seed('anthropic')
    const quotas = (await (await s.get('/api/provider/quotas')).json()) as { sources: Json[] }
    const sidebar = quotas.sources.find((q) => q.provider_id === 'anthropic')!
    const reads = accountReads()
    const { result } = await read()
    // No provider read: the answer is the sidebar's cached rows.
    expect(accountReads()).toBe(reads)
    const usage = (await (await s.get(`/api/session/usage?session_id=${CALLER}`)).json()) as Json
    const row = ((await (await s.get(`/api/session?session_id=${CALLER}&messages=0`)).json()) as { session: Json }).session
    expect(result).toMatchObject({
      session_id: CALLER, model: usage.model, provider: 'anthropic',
      input_tokens: { tokens: usage.input_tokens, text: '123,456' }, output_tokens: { tokens: usage.output_tokens, text: '7,890' }, cache_read_tokens: { tokens: row.cache_read_tokens, text: '98,765' },
      cost: { usd: usage.estimated_cost, text: '$1.23' }, turns: { count: 2, text: '2' },
      context: {
        used_tokens: { tokens: row.context_used_tokens, text: '50,000' }, context_length: { tokens: row.context_window_tokens, text: '200,000' },
        threshold_tokens: { tokens: row.threshold_tokens, text: '160,000' }, percent_used: { percent: row.context_usage_percent, text: '25%' },
      },
      quota_reason: null,
    })
    const windows = sidebar.windows as Json[]
    expect(result!.quota).toEqual({ provider: 'anthropic', sources: [{
      name: sidebar.display_name, status: 'available', level: sidebar.display_level, message: sidebar.status_message, credits: null,
      fetched_at: { at: '2026-11-09T11:57:00.000Z', text: '3m ago' },
      windows: [
        { label: 'Session', used_percent: { percent: windows[0]!.used_percent, text: '42%' }, remaining_percent: { percent: windows[0]!.remaining_percent, text: '58%' }, resets_at: { at: '2026-11-09T14:05:00.000Z', text: 'in 2h 5m' }, level: windows[0]!.display_level },
        { label: 'Weekly', used_percent: { percent: 61, text: '61%' }, remaining_percent: { percent: 39, text: '39%' }, resets_at: { at: '2026-11-12T12:00:00.000Z', text: 'in 3d' }, level: windows[1]!.display_level },
      ],
    }] })
    record(0, { caller_session_id: CALLER }, result)
  })

  it('answers quota null with the reason before any quota read, and for a provider that reports no quota', async () => {
    await seed('anthropic')
    expect((await read()).result).toMatchObject({ quota: null, quota_reason: 'Talaria has no quota reading cached; it reads quotas when the sidebar or Insights shows them.' })
    expect(accountReads()).toBe(0)

    config = { model: { default: 'glm-5', provider: 'zai' }, providers: { zai: { api_key: 'synthetic-zai-key' } } }
    writeFileSync(join(s.state, 'config.yaml'), '# zai\n')
    s.deps.agentConfig.invalidate()
    await seed('zai', ZAI_CALLER)
    const zai = ((await (await s.get('/api/provider/quotas')).json()) as { sources: Json[] }).sources.find((q) => q.provider_id === 'zai')!
    const { result } = await read(ZAI_CALLER)
    expect(result).toMatchObject({ provider: 'zai', quota: null, quota_reason: zai.status_message })
    expect(result!.quota_reason).toMatch(/No verified server-side quota/)
    record(1, { caller_session_id: ZAI_CALLER }, result)
  })

  it('answers the stale rows the sidebar shows when a later quota read could not confirm them', async () => {
    await seed('anthropic')
    await s.get('/api/provider/quotas')
    const fail = () => { throw new SidecarError('Agent update recovery is incomplete.', { condition: 'agent_runtime_stale', data: {} }) }
    for (const method of ['usage.pool', 'usage.pool_providers', 'providers.auth_status', 'plugins.providers'] as const) sidecar.respond(method, fail)
    const quotas = (await (await s.get('/api/provider/quotas?refresh=1')).json()) as { availability: { authoritative: boolean }; sources: Json[] }
    expect(quotas.availability.authoritative).toBe(false)
    const sidebar = quotas.sources.find((q) => q.provider_id === 'anthropic')!
    expect(sidebar.status).toBe('stale')
    const source = ((await read()).result!.quota as { sources: Json[] }).sources[0]!
    expect(source).toMatchObject({ status: 'stale', level: sidebar.display_level, message: sidebar.status_message })
    expect((source.windows as Json[]).map((w) => w.level)).toEqual((sidebar.windows as Json[]).map((w) => w.display_level))
  })

  it('reads only a stored caller session', async () => {
    expect(await read('20261109_090000_unknown')).toEqual({ error: { condition: 'caller_unknown' } })
  })
})
