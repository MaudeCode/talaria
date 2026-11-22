import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { str } from '../util.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const completed = (messages: Json[]): SidecarResult<'chat.start'> => ({
  status: 'completed', messages, final_response: str(messages.at(-1)?.content), error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
  usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'gpt-6-astra', provider: 'openai-codex', compressed: false,
  agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
})
// Synthetic resolver answers: the Codex route offers Fast and Ultrafast, Anthropic offers Fast, anything else none.
const STANDARD = { id: 'standard', service_tier: 'default' } as const
const TIERS: Record<string, SidecarResult<'models.speed_tiers'>['tiers'][number]> = {
  'openai-codex': [STANDARD, { id: 'priority', service_tier: 'priority' }, { id: 'ultrafast', service_tier: 'ultrafast' }],
  anthropic: [STANDARD, { id: 'fast', service_tier: 'priority' }],
}

/** TAL-1423: a direct chat's speed is its own; the profile's main-model tier is only what a chat without a pick inherits. */
describe('per-chat speed tier', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let tiersAnswer: 'ok' | 'fail' = 'ok'
  const configs = new Map<string, Json>()
  const setConfig = (home: string, config: Json): void => {
    configs.set(home, config)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.yaml'), `# fake ${String(Math.random())}\n`)
    s.deps.agentConfig.invalidate()
  }
  const newChat = async (): Promise<string> => String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
  const speedOf = async (sid: string): Promise<Json> => json(await s.get(`/api/reasoning?session_id=${sid}`))
  const setSpeed = (sid: string, tier: string): Promise<Response> => post(s, '/api/reasoning', { session_id: sid, service_tier: tier })
  const persisted = async (sid: string): Promise<Json> => {
    const stored = await s.deps.sessionStore.deps.storage.sessions.readDocument(sid)
    if (!stored) throw new Error(`session ${sid} is not stored`)
    return stored.doc
  }
  const moveChat = async (sid: string, model: string, provider: string): Promise<void> => {
    const session = await s.deps.sessionStore.get(sid)
    session.model = model
    session.model_provider = provider
    await s.deps.sessionStore.save(session)
  }
  const turnTier = async (sid: string): Promise<unknown> => {
    let seen: Json = {}
    sidecar.respond('chat.start', (params) => { seen = params; return completed([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }]) })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'hi' }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'done' || f.event === 'apperror')
    return seen.service_tier
  }

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    sidecar.respond('config.get', (params) => {
      const path = join(params.profile_home, 'config.yaml')
      return existsSync(path) ? { path, exists: true, config: structuredClone(configs.get(params.profile_home) ?? {}) } : { path, exists: false, config: {} }
    })
    sidecar.respond('models.reasoning_efforts', () => ({ efforts: [], supports_reasoning: false }))
    sidecar.respond('models.speed_tiers', (params) => {
      if (tiersAnswer === 'fail') throw new Error('resolver unavailable')
      return { tiers: params.routes.map((route) => TIERS[route.provider] ?? []) }
    })
  })
  beforeEach(() => {
    tiersAnswer = 'ok'
    setConfig(s.state, { model: { default: 'gpt-6-astra', provider: 'openai-codex', service_tier: 'priority' } })
  })
  afterAll(() => s.close())

  it('keeps two chats independent, leaves the profile tier alone, and survives a reload into the turn', async () => {
    const a = await newChat()
    const b = await newChat()
    expect(await speedOf(a)).toMatchObject({ service_tier: 'priority', supported_speed_tiers: TIERS['openai-codex'] })
    const set = await setSpeed(a, 'ultrafast')
    expect(set.status).toBe(200)
    expect(await json(set)).toMatchObject({ service_tier: 'ultrafast' })
    expect((await speedOf(b)).service_tier).toBe('priority')
    expect(configs.get(s.state)?.model).toEqual({ default: 'gpt-6-astra', provider: 'openai-codex', service_tier: 'priority' })
    expect((await persisted(a)).service_tier).toBe('ultrafast')
    s.deps.sessionStore.sessions.delete(a)
    expect((await speedOf(a)).service_tier).toBe('ultrafast')
    expect(await turnTier(a)).toBe('ultrafast')
    expect(await turnTier(b)).toBe('priority')
    expect((await setSpeed(b, 'default')).status).toBe(200)
    expect(await turnTier(b)).toBe('default')
  })

  it('recomputes the offered and effective speed on the server when the chat moves to another model', async () => {
    const picked = await newChat()
    const inherited = await newChat()
    await setSpeed(picked, 'ultrafast')
    await moveChat(picked, 'claude-opus-4-8', 'anthropic')
    await moveChat(inherited, 'claude-opus-4-8', 'anthropic')
    // Ultrafast is not offered on Anthropic, and the profile's tier belongs to its main model only.
    expect(await speedOf(picked)).toMatchObject({ service_tier: 'default', supported_speed_tiers: TIERS.anthropic })
    expect(await speedOf(inherited)).toMatchObject({ service_tier: 'default', supported_speed_tiers: TIERS.anthropic })
    expect((await persisted(picked)).service_tier).toBe('ultrafast')
    await moveChat(picked, 'glm-5', 'zai')
    expect(await speedOf(picked)).toMatchObject({ service_tier: 'default', supported_speed_tiers: [] })
  })

  it('refuses a speed the route does not offer, or that the Agent cannot confirm, without a write', async () => {
    const sid = await newChat()
    await moveChat(sid, 'claude-opus-4-8', 'anthropic')
    const refused = await setSpeed(sid, 'ultrafast')
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ code: 'speed_unsupported' })
    tiersAnswer = 'fail'
    expect((await setSpeed(sid, 'priority')).status).toBe(503)
    expect((await speedOf(sid)).supported_speed_tiers).toEqual([])
    expect(await persisted(sid)).not.toHaveProperty('service_tier')
    expect((await post(s, '/api/reasoning', { service_tier: 'priority' })).status).toBe(400)
    expect(configs.get(s.state)?.model).toEqual({ default: 'gpt-6-astra', provider: 'openai-codex', service_tier: 'priority' })
  })

  it('carries the pick through duplicate and forks', async () => {
    const sid = await newChat()
    await setSpeed(sid, 'default')
    await turnTier(sid)
    const dup = String(((await json(await post(s, '/api/session/duplicate', { session_id: sid }))).session as Json).session_id)
    const fork = String((await json(await post(s, '/api/session/branch', { session_id: sid, keep_count: null }))).session_id)
    expect([(await persisted(dup)).service_tier, (await persisted(fork)).service_tier]).toEqual(['default', 'default'])
  })
})
