import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { sessionPath } from '../test/storage.js'
import { str } from '../util.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const completed = (messages: Json[]): SidecarResult<'chat.start'> => ({
  status: 'completed', messages, final_response: str(messages.at(-1)?.content), error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
  usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'claude-sonnet-4-6', provider: 'anthropic', compressed: false,
  agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
})

/** TAL-1647: a direct chat's reasoning effort is its own; the profile default seeds new chats and settles legacy ones. */
describe('per-chat reasoning effort', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  const configs = new Map<string, Json>()
  const profileHome = (): string => join(s.state, 'profiles', 'work')
  const profileRow = (name: string, path: string, isDefault: boolean): Json => ({ name, path, is_default: isDefault, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 })
  const setConfig = (home: string, config: Json): void => {
    configs.set(home, config)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.yaml'), `# fake ${String(Math.random())}\n`)
    s.deps.agentConfig.invalidate()
  }
  const newChat = async (headers: Record<string, string> = {}): Promise<string> => String(((await json(await post(s, '/api/session/new', {}, headers))).session as Json).session_id)
  const effortOf = async (sid: string, headers: Record<string, string> = {}): Promise<Json> => json(await s.get(`/api/reasoning?session_id=${sid}`, { headers }))
  const persisted = (sid: string): Json => JSON.parse(readFileSync(sessionPath(s.deps.sessionStore, sid), 'utf8')) as Json
  const reload = (sid: string): void => { s.deps.sessionStore.sessions.delete(sid) }
  const turnReasoning = async (sid: string, headers: Record<string, string> = {}): Promise<unknown> => {
    let seen: Json = {}
    sidecar.respond('chat.start', (params) => { seen = params; return completed([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }]) })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'hi' }, headers))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'done' || f.event === 'apperror', { headers })
    return seen.reasoning_config
  }

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    sidecar.respond('config.get', (params) => {
      const path = join(params.profile_home, 'config.yaml')
      return existsSync(path) ? { path, exists: true, config: structuredClone(configs.get(params.profile_home) ?? {}) } : { path, exists: false, config: {} }
    })
    sidecar.respond('config.set', (params) => {
      configs.set(params.profile_home, params.config)
      writeFileSync(join(params.profile_home, 'config.yaml'), `# fake ${String(Math.random())}\n`)
      return { ok: true as const, path: join(params.profile_home, 'config.yaml') }
    })
    sidecar.respond('models.reasoning_efforts', (params) => ({ efforts: params.model.startsWith('claude') ? ['low', 'medium', 'high'] : [], supports_reasoning: params.model.startsWith('claude') }))
  })
  beforeEach(() => {
    setConfig(s.state, { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' }, agent: { reasoning_effort: 'high' } })
  })
  afterAll(() => s.close())

  it('keeps two chats independent, leaves the profile default alone, and survives a reload into the turn', async () => {
    const a = await newChat()
    const b = await newChat()
    const set = await post(s, '/api/reasoning', { session_id: a, effort: 'low' })
    expect(set.status).toBe(200)
    expect(await json(set)).toMatchObject({ reasoning_effort: 'low', supported_efforts: ['low', 'medium', 'high'] })
    expect((await effortOf(a)).reasoning_effort).toBe('low')
    expect((await effortOf(b)).reasoning_effort).toBe('high')
    expect(configs.get(s.state)?.agent).toEqual({ reasoning_effort: 'high' })
    expect((await json(await s.get('/api/reasoning'))).reasoning_effort).toBe('high')
    expect(persisted(a).reasoning_effort).toBe('low')
    reload(a)
    expect((await effortOf(a)).reasoning_effort).toBe('low')
    expect((await json(await s.get(`/api/session?session_id=${a}`))).session).toMatchObject({ reasoning_effort: 'low' })
    expect(await turnReasoning(a)).toEqual({ enabled: true, effort: 'low' })
    expect(await turnReasoning(b)).toEqual({ enabled: true, effort: 'high' })
  })

  it('snapshots the owning profile default for new chats, inherits it for legacy chats, and honors an explicit provider default', async () => {
    const snapshot = await newChat()
    const legacy = await newChat()
    const reset = await newChat()
    await post(s, '/api/reasoning', { session_id: reset, effort: '' })
    const stored = await s.deps.sessionStore.get(legacy)
    stored.reasoning_effort = null
    await s.deps.sessionStore.save(stored)
    expect((await s.deps.sessionStore.get(snapshot)).reasoning_effort).toBe('high')
    // A later profile change reaches only the legacy chat.
    expect((await post(s, '/api/reasoning', { effort: 'medium' })).status).toBe(200)
    expect(configs.get(s.state)?.agent).toEqual({ reasoning_effort: 'medium' })
    expect((await effortOf(snapshot)).reasoning_effort).toBe('high')
    expect((await effortOf(legacy)).reasoning_effort).toBe('medium')
    expect((await effortOf(reset)).reasoning_effort).toBe('')
    expect(await turnReasoning(reset)).toBeNull()
    expect(await turnReasoning(legacy)).toEqual({ enabled: true, effort: 'medium' })
  })

  it('recomputes supported and effective levels for the chat model on the server', async () => {
    const sid = await newChat()
    await post(s, '/api/reasoning', { session_id: sid, effort: 'xhigh' })
    expect(persisted(sid).reasoning_effort).toBe('xhigh')
    expect(await effortOf(sid)).toMatchObject({ reasoning_effort: 'high', supported_efforts: ['low', 'medium', 'high'], supports_reasoning_effort: true })
    const session = await s.deps.sessionStore.get(sid)
    session.model = 'gpt-4o'
    session.model_provider = 'openai'
    await s.deps.sessionStore.save(session)
    expect(await effortOf(sid)).toMatchObject({ reasoning_effort: 'xhigh', supported_efforts: [], supports_reasoning_effort: false })
  })

  it('snapshots each profile default separately and keeps profile settings writes', async () => {
    setConfig(profileHome(), { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' }, agent: { reasoning_effort: 'low' } })
    sidecar.respond('profiles.list', () => ({ profiles: [profileRow('default', s.state, true), profileRow('work', profileHome(), false)] }) as never)
    s.deps.profiles.invalidate()
    try {
      const cookie = ((await post(s, '/api/profile/switch', { name: 'work' })).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      const work = await newChat({ cookie })
      const root = await newChat()
      expect((await effortOf(work, { cookie })).reasoning_effort).toBe('low')
      expect((await effortOf(root)).reasoning_effort).toBe('high')
      expect((await post(s, '/api/reasoning', { session_id: work, effort: 'medium' }, { cookie })).status).toBe(200)
      expect(configs.get(profileHome())?.agent).toEqual({ reasoning_effort: 'low' })
      expect(configs.get(s.state)?.agent).toEqual({ reasoning_effort: 'high' })
      expect(await turnReasoning(work, { cookie })).toEqual({ enabled: true, effort: 'medium' })
      // Another profile's chat is not a target from here.
      expect((await post(s, '/api/reasoning', { session_id: work, effort: 'low' })).status).toBe(404)
      expect((await s.get(`/api/reasoning?session_id=${work}`)).status).toBe(404)
      expect(persisted(work).reasoning_effort).toBe('medium')
      // No session_id stays the profile setting.
      expect((await post(s, '/api/reasoning', { effort: 'medium' }, { cookie })).status).toBe(200)
      expect(configs.get(profileHome())?.agent).toEqual({ reasoning_effort: 'medium' })
    } finally {
      sidecar.respond('profiles.list', () => ({ profiles: [profileRow('default', s.state, true)] }) as never)
      s.deps.profiles.invalidate()
    }
  })

  it('carries the choice through duplicate, forks, import, focused recovery and clear', async () => {
    const sid = await newChat()
    await post(s, '/api/reasoning', { session_id: sid, effort: 'low' })
    await turnReasoning(sid)
    const dup = String(((await json(await post(s, '/api/session/duplicate', { session_id: sid }))).session as Json).session_id)
    expect(persisted(dup).reasoning_effort).toBe('low')
    for (const keep of [null, 1]) {
      const fork = String((await json(await post(s, '/api/session/branch', { session_id: sid, keep_count: keep }))).session_id)
      expect(persisted(fork).reasoning_effort).toBe('low')
    }
    const exported = await json(await s.get(`/api/session/export?session_id=${sid}`))
    expect(exported.reasoning_effort).toBe('low')
    const imported = String(((await json(await post(s, '/api/session/import', exported))).session as Json).session_id)
    expect(persisted(imported).reasoning_effort).toBe('low')
    const plain = String(((await json(await post(s, '/api/session/import', { messages: [] }))).session as Json).session_id)
    expect((await effortOf(plain)).reasoning_effort).toBe('high')
    const exhausted = await s.deps.sessionStore.get(sid)
    exhausted.compression_recovery = { terminal_state: 'compression_exhausted', recommended_action: 'start_focused_continuation' }
    exhausted.recommended_recovery_action = 'start_focused_continuation'
    await s.deps.sessionStore.save(exhausted)
    const recovery = await post(s, '/api/session/compression-recovery/start', { session_id: sid })
    expect(recovery.status).toBe(200)
    const child = String(((await json(recovery)).session as Json).session_id)
    expect(persisted(child).reasoning_effort).toBe('low')
    expect((await post(s, '/api/session/clear', { session_id: sid })).status).toBe(200)
    expect(persisted(sid).reasoning_effort).toBe('low')
    expect((persisted(sid).messages as Json[]).filter((m) => m.role === 'user' || m.role === 'assistant')).toEqual([])
  })

  it('preserves shares and drafts across concurrent reasoning writes', async () => {
    const sid = await newChat()
    await turnReasoning(sid)
    const writes = await Promise.all([
      post(s, '/api/reasoning', { session_id: sid, effort: 'low' }),
      post(s, '/api/share/create', { session_id: sid }),
      post(s, '/api/session/draft', { session_id: sid, text: 'draft text', files: [] }),
    ])
    expect(writes.map((r) => r.status)).toEqual([200, 200, 200])
    reload(sid)
    const doc = persisted(sid)
    expect(doc.reasoning_effort).toBe('low')
    expect(doc.share_token).toBeTruthy()
    expect((await json(await s.get(`/api/session/draft?session_id=${sid}`))).draft).toMatchObject({ text: 'draft text' })
  })
})
