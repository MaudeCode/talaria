/** TAL-1649: the server's per-conversation skill provenance, from successful loads only, behind every lifecycle fence. */
import { describe, expect, it, vi } from 'vitest'
import type { SidecarParams, SidecarResultInput, SessionSkills } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

interface Frame { event: string; data: Record<string, unknown> }

function completed(params: SidecarParams<'chat.start'>): SidecarResultInput<'chat.start'> {
  return {
    status: 'completed', messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'answer' }], final_response: 'answer', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
    agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
  }
}

const tool = (tid: string, name: string, rawResult: unknown): Frame[] => [
  { event: 'tool', data: { name, tid, args: { name: 'x' } } },
  { event: 'tool_complete', data: { event_type: 'tool.completed', name, tid, preview: 'ok', raw_result: rawResult } },
]
const view = (tid: string, name: string) => tool(tid, 'skill_view', { success: true, name, description: 'd', content: 'body' })

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

const viewed = (name: string) => ({ success: true as const, name, description: 'd', tags: [], related_skills: [], content: 'body', path: `/skills/${name}/SKILL.md`, skill_dir: `/skills/${name}`, linked_files: {} })
const LIBRARY = [{ name: 'review', description: 'Code review', category: null, disabled: false }, { name: 'deploy', description: 'Ship it', category: null, disabled: false }]

async function boot(sidecar = new FakeSidecar()): Promise<{ server: TestServer; sidecar: FakeSidecar }> {
  sidecar.respond('skills.list', () => ({ success: true, skills: LIBRARY, categories: [], count: LIBRARY.length }))
  sidecar.respond('skills.view', (params) => (LIBRARY.some((s) => s.name === params.name) ? viewed(params.name) : { success: false as const, error: 'not found' }))
  return { server: await bootTestServer({ sidecar }), sidecar }
}

async function newSession(server: TestServer, profile?: string): Promise<string> {
  const session = await server.deps.sessionStore.newSession()
  session.messages = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }]
  session.context_messages = structuredClone(session.messages)
  if (profile) session.profile = profile
  await server.deps.sessionStore.save(session)
  return session.session_id
}

const post = (server: TestServer, path: string, body: unknown) => server.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

async function startTurn(server: TestServer, sid: string): Promise<string> {
  const res = await post(server, '/api/chat/start', { session_id: sid, message: 'hello' })
  expect(res.status).toBe(200)
  return ((await res.json()) as { stream_id: string }).stream_id
}

async function runTurn(server: TestServer, sidecar: FakeSidecar, sid: string, frames: Frame[]): Promise<void> {
  sidecar.respond('chat.start', (params, emit) => { for (const f of frames) emit(f); return completed(params) })
  const streamId = await startTurn(server, sid)
  await server.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
}

async function skills(server: TestServer, sid: string): Promise<SessionSkills['skills']> {
  const res = await server.get(`/api/session/skills?session_id=${sid}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as SessionSkills).skills
}
const counts = async (server: TestServer, sid: string) => Object.fromEntries((await skills(server, sid)).map((s) => [s.name, s.count]))

describe('session skill provenance (TAL-1649)', () => {
  it('counts only successful skill_view completions, once per completion, in server order with library detail', async () => {
    const { server, sidecar } = await boot()
    try {
      const sid = await newSession(server)
      expect(await skills(server, sid)).toEqual([])
      await runTurn(server, sidecar, sid, [
        ...view('a', 'deploy'),
        ...view('b', 'review'),
        ...view('c', 'review'),
        // The same completion delivered twice counts once.
        { event: 'tool_complete', data: { event_type: 'tool.completed', name: 'skill_view', tid: 'c', preview: 'ok', raw_result: { success: true, name: 'review' } } },
        ...tool('d', 'skill_view', { success: false, error: 'Skill not found', name: 'missing' }),
        ...tool('e', 'skill_view', { success: true, error: 'disabled', name: 'errored' }),
        ...tool('f', 'skill_view', 'not json'),
        ...tool('g', 'terminal', { success: true, name: 'forged' }),
        ...view('h', 'retired'),
      ])
      expect(await skills(server, sid)).toEqual([
        { name: 'review', count: 2, description: 'Code review', detail_available: true },
        { name: 'deploy', count: 1, description: 'Ship it', detail_available: true },
        // A skill the library no longer resolves keeps its count, without detail.
        { name: 'retired', count: 1, description: null, detail_available: false },
      ])
      // Persisted: a cold read after cache eviction still has them; a new turn adds to them.
      server.deps.sessionStore.sessions.delete(sid)
      expect(await counts(server, sid)).toEqual({ review: 2, deploy: 1, retired: 1 })
      await runTurn(server, sidecar, sid, view('i', 'deploy'))
      expect(await counts(server, sid)).toEqual({ review: 2, deploy: 2, retired: 1 })
    } finally { await server.close() }
  })

  it('counts explicit skill and bundle loads naming the session; a library preview counts nothing', async () => {
    const { server, sidecar } = await boot()
    sidecar.respond('commands.bundle_resolve', () => ({ name: 'ship', source: 'bundle', message: 'Load the bundle', loaded_skills: ['review', 'deploy'], missing_skills: ['gone'] }))
    try {
      const sid = await newSession(server)
      expect((await server.get('/api/skills/content?name=review')).status).toBe(200)
      expect((await server.get('/api/skills/content?name=review&file=notes.md&session_id=' + sid)).status).not.toBe(200)
      expect((await post(server, '/api/commands/bundles/resolve', { command: '/ship' })).status).toBe(200)
      expect(await counts(server, sid)).toEqual({})
      expect((await server.get(`/api/skills/content?name=review&session_id=${sid}`)).status).toBe(200)
      // A failed view answers as before and counts nothing.
      expect(((await (await server.get(`/api/skills/content?name=missing&session_id=${sid}`)).json()) as { success: boolean }).success).toBe(false)
      expect((await post(server, '/api/commands/bundles/resolve', { command: '/ship', session_id: sid })).status).toBe(200)
      expect(await counts(server, sid)).toEqual({ review: 2, deploy: 1 })
    } finally { await server.close() }
  })

  it('refuses explicit loads for read-only, other-profile and unknown sessions', async () => {
    const { server, sidecar } = await boot()
    sidecar.respond('commands.bundle_resolve', () => ({ name: 'ship', source: 'bundle', message: 'Load the bundle', loaded_skills: ['review'], missing_skills: [] }))
    try {
      const readOnly = await newSession(server)
      const s = await server.deps.sessionStore.get(readOnly)
      s.read_only = true
      await server.deps.sessionStore.save(s)
      const foreign = await newSession(server, 'work')
      // A read-only or unknown session still gets its skill; nothing is recorded.
      for (const sid of [readOnly, 'nosuchsession1']) {
        expect((await server.get(`/api/skills/content?name=review&session_id=${sid}`)).status).toBe(200)
        expect((await post(server, '/api/commands/bundles/resolve', { command: '/ship', session_id: sid })).status).toBe(200)
      }
      // Another profile's session, or an unsafe id, is not this request's to name.
      for (const sid of [foreign, '../bad']) expect((await server.get(`/api/skills/content?name=review&session_id=${encodeURIComponent(sid)}`)).status).toBe(404)
      expect(await counts(server, readOnly)).toEqual({})
      expect(await server.deps.sessionStore.persistedIds()).not.toContain('nosuchsession1')
      const stored = await server.deps.sessionStore.get(foreign)
      expect(stored.extra.skill_provenance).toBeUndefined()
      expect((await server.get(`/api/session/skills?session_id=${foreign}`)).status).toBe(404)
    } finally { await server.close() }
  })

  it('never records an ephemeral /btw turn into the conversation', async () => {
    const { server, sidecar } = await boot()
    try {
      const sid = await newSession(server)
      const record = vi.spyOn(server.deps.sessions, 'recordSkillUse')
      sidecar.respond('chat.start', (params, emit) => { for (const f of view('a', 'review')) emit(f); return completed(params) })
      const res = await post(server, '/api/btw', { session_id: sid, question: 'quick one' })
      expect(res.status).toBe(200)
      const btw = (await res.json()) as { stream_id: string }
      const frames = await server.sse(`/api/chat/stream?stream_id=${btw.stream_id}&replay=1`, (f) => f.event === 'done')
      expect(frames.some((f) => f.event === 'tool_complete')).toBe(true)
      await server.deps.turns.finished(btw.stream_id)
      // The clone is thrown away; nothing is written for it, and the conversation it came from is unchanged.
      expect(record).not.toHaveBeenCalled()
      expect(await counts(server, sid)).toEqual({})
    } finally { await server.close() }
  })

  it('clear resets counts and fences a completion or explicit load that started before it', async () => {
    const { server, sidecar } = await boot()
    try {
      const sid = await newSession(server)
      await runTurn(server, sidecar, sid, view('a', 'deploy'))
      // A turn still streaming when the conversation is cleared.
      const gate = deferred()
      const reached = deferred()
      sidecar.respond('chat.start', async (params, emit) => {
        for (const f of view('b', 'review')) emit(f)
        reached.resolve()
        await gate.promise
        for (const f of view('c', 'review')) emit(f)
        return completed(params)
      })
      const streamId = await startTurn(server, sid)

      await reached.promise
      // An explicit load already resolving when the clear lands.
      const viewGate = deferred()
      const viewing = deferred()
      sidecar.respond('skills.view', async (params) => { viewing.resolve(); await viewGate.promise; return viewed(params.name) })
      const load = server.get(`/api/skills/content?name=deploy&session_id=${sid}`)
      await viewing.promise
      expect((await post(server, '/api/session/clear', { session_id: sid })).status).toBe(200)
      expect(await counts(server, sid)).toEqual({})
      viewGate.resolve()
      expect((await load).status).toBe(200)
      gate.resolve()
      await server.deps.turns.finished(streamId)
      expect(await counts(server, sid)).toEqual({})
      // A load that starts after the clear counts again.
      expect((await server.get(`/api/skills/content?name=deploy&session_id=${sid}`)).status).toBe(200)
      expect(await counts(server, sid)).toEqual({ deploy: 1 })
    } finally { await server.close() }
  })

  it('a cancelled stream cannot record a late completion', async () => {
    const { server, sidecar } = await boot()
    try {
      const sid = await newSession(server)
      const gate = deferred()
      const reached = deferred()
      sidecar.respond('chat.start', async (params, emit) => {
        reached.resolve()
        await gate.promise
        for (const f of view('late', 'review')) emit(f)
        return { ...completed(params), status: 'cancelled' }
      })
      sidecar.respond('chat.interrupt', () => ({ ok: true }))
      const streamId = await startTurn(server, sid)
      const frames = server.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
      await reached.promise
      expect((await server.get(`/api/chat/cancel?stream_id=${streamId}`)).status).toBe(200)
      gate.resolve()
      await frames
      expect(await counts(server, sid)).toEqual({})
    } finally { await server.close() }
  })

  it('delete never resurrects a session through a late explicit load', async () => {
    const { server, sidecar } = await boot()
    try {
      const sid = await newSession(server)
      const viewGate = deferred()
      const viewing = deferred()
      sidecar.respond('skills.view', async (params) => { viewing.resolve(); await viewGate.promise; return viewed(params.name) })
      const load = server.get(`/api/skills/content?name=review&session_id=${sid}`)
      await viewing.promise
      expect((await post(server, '/api/session/delete', { session_id: sid })).status).toBe(200)
      viewGate.resolve()
      expect((await load).status).toBe(200)
      expect((await server.get(`/api/session/skills?session_id=${sid}`)).status).toBe(404)
      expect(await server.deps.sessionStore.persistedIds()).not.toContain(sid)
    } finally { await server.close() }
  })

  it('a duplicate or whole-history fork keeps the counts; a partial fork starts empty', async () => {
    const { server, sidecar } = await boot()
    try {
      const sid = await newSession(server)
      await runTurn(server, sidecar, sid, [...view('a', 'review'), ...view('b', 'review')])
      const copy = ((await (await post(server, '/api/session/duplicate', { session_id: sid })).json()) as { session: { session_id: string } }).session.session_id
      expect(await counts(server, copy)).toEqual({ review: 2 })
      const whole = ((await (await post(server, '/api/session/branch', { session_id: sid })).json()) as { session_id: string }).session_id
      expect(await counts(server, whole)).toEqual({ review: 2 })
      const partial = ((await (await post(server, '/api/session/branch', { session_id: sid, keep_count: 1 })).json()) as { session_id: string }).session_id
      expect(await counts(server, partial)).toEqual({})
      // The copies count on their own from here.
      await runTurn(server, sidecar, copy, view('c', 'deploy'))
      expect(await counts(server, copy)).toEqual({ review: 2, deploy: 1 })
      expect(await counts(server, sid)).toEqual({ review: 2 })
    } finally { await server.close() }
  })
})
