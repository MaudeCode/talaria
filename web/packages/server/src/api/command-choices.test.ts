import { afterEach, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, cookieHeader, type TestServer } from '../test/harness.js'

let server: TestServer | undefined
afterEach(async () => { await server?.close() })

it.each(['profile', 'principal'] as const)('bounds commands by %s before dispatch and releases the budget', async (boundary) => {
  const sidecar = new FakeSidecar()
  const s = server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', HERMES_WEBUI_GROUP_PROFILE_MAP: '{"ops":"work"}' } })
  const identities: Record<string, Record<string, string>> = {}
  for (const [key, user, group] of [['kimWork', 'kim', 'ops'], ['kimRoot', 'kim', 'dev'], ['leeWork', 'lee', 'ops'], ['leeRoot', 'lee', 'dev']]) {
    const response = await s.get('/api/auth/status', { headers: { 'X-Remote-User': user!, 'X-Remote-Groups': group! } })
    const cookie = cookieHeader(response.headers.getSetCookie(), 'hermes_session')
    const headers = { cookie: cookie!, 'X-Remote-User': user!, 'X-Remote-Groups': group!, origin: s.base }
    const bootstrap = await (await s.get('/api/bootstrap', { headers })).json() as { csrf_token: string }
    identities[key!] = { ...headers, 'X-Hermes-CSRF-Token': bootstrap.csrf_token, 'content-type': 'application/json' }
  }
  const post = (identity: string, path: string, body: unknown) => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: identities[identity]! })
  const work = await (await post('kimWork', '/api/session/new', {})).json() as { session: { session_id: string } }
  const root = await (await post('kimRoot', '/api/session/new', {})).json() as { session: { session_id: string } }
  const held: (() => void)[] = []
  let executed = 0
  sidecar.respond('commands.exec', () => {
    executed += 1
    if (executed > 2) return { output: 'completed', source: 'plugin' }
    return new Promise((resolve) => { held.push(() => { resolve({ output: 'completed', source: 'plugin' }) }) })
  })
  const run = (identity: string, sid: string) => post(identity, '/api/commands/exec', { command: '/probe-choice', session_id: sid })
  const first = run('kimWork', work.session.session_id)
  const second = run('kimWork', work.session.session_id)
  try {
    await expect.poll(() => held.length).toBe(2)
    const blocked = await run(boundary === 'profile' ? 'leeWork' : 'kimRoot', boundary === 'profile' ? work.session.session_id : root.session.session_id)
    expect(blocked.status).toBe(429)
    expect(executed).toBe(2)
    // Another principal in another profile still reaches its handler.
    expect((await run('leeRoot', root.session.session_id)).status).toBe(200)
    held[0]!()
    expect((await first).status).toBe(200)
    expect((await run('kimWork', work.session.session_id)).status).toBe(200)
  } finally {
    for (const finish of held) finish()
    await Promise.allSettled([first, second])
  }
  expect(s.deps.commandSlots.active).toBe(0)
})

it('answers a running plugin command through the ordinary clarification stream without a chat turn', async () => {
  const sidecar = new FakeSidecar()
  const s = server = await bootTestServer({ sidecar })
  const session = await s.deps.sessions.create({ title: 'Plugin choice' })
  const sid = session.session_id
  const post = (path: string, body: unknown) => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  let release!: () => void
  let started!: () => void
  const admitted = new Promise<void>((resolve) => { started = resolve })
  const answer = new Promise<void>((resolve) => { release = resolve })
  sidecar.respond('commands.exec', async (params, emit, opts) => {
    expect(params).toMatchObject({ session_id: sid, profile_home: s.deps.profileHome('default'), workspace: session.workspace })
    expect(opts.timeoutMs).toBe(120_000)
    emit({ event: 'clarify', data: { session_id: sid, clarify_id: 'command-choice', questions: [{ qid: 'q0', question: 'Environment?', choices: ['Development', 'Production'], multi_select: false }] } })
    started()
    await answer
    emit({ event: 'clarify_resolved', data: { session_id: sid, clarify_id: 'command-choice' } })
    return { output: 'private-dev', source: 'plugin' }
  })
  sidecar.respond('clarify.respond', (params) => {
    expect(params).toMatchObject({ session_id: sid, clarify_id: 'command-choice', response: '{"answers":{"q0":"Development"}}', profile_home: s.deps.profileHome('default') })
    release()
    return { ok: true, clarify_id: 'command-choice' }
  })
  const command = post('/api/commands/exec', { session_id: sid, command: '/probe-choice' })
  try {
    await admitted
    const frames = await s.sse(`/api/clarify/stream?session_id=${sid}`, (f) => f.event === 'initial')
    expect(frames[0]?.data).toMatchObject({ pending: { clarify_id: 'command-choice', steps: [{ qid: 'q0', question: 'Environment?', choices: ['Development', 'Production'], multi_select: false }] }, pending_count: 1 })
    expect((await post('/api/clarify/respond', { session_id: sid, clarify_id: 'command-choice', answers: { q0: 'Development' } })).status).toBe(200)
    const result = await command
    expect(await result.json()).toEqual({ output: 'private-dev' })
    expect(s.deps.pending.clarifyPending(sid)).toEqual({ pending: null, pending_count: 0 })
    expect(sidecar.calls.filter((c) => c.method === 'commands.exec')).toHaveLength(1)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
    expect((await s.deps.sessionStore.get(sid)).messages).toEqual([])
  } finally { release(); await command }
})

it.each(['error', 'disconnect'] as const)('withdraws only its own prompts on command %s and never replays the handler', async (outcome) => {
  const sidecar = new FakeSidecar()
  const s = server = await bootTestServer({ sidecar })
  const sid = (await s.deps.sessions.create({ title: 'Lost command' })).session_id
  s.deps.pending.submitClarify(sid, { clarify_id: 'other-command', question: 'Other?' })
  let started!: () => void
  let fail!: () => void
  const admitted = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { fail = resolve })
  sidecar.respond('commands.exec', async (_params, emit, opts) => {
    emit({ event: 'clarify', data: { session_id: sid, clarify_id: 'lost-command', question: 'Environment?' } })
    opts.signal?.addEventListener('abort', fail, { once: true })
    started()
    await gate
    throw new SidecarError('Unknown command outcome', { condition: 'sidecar_unavailable' })
  })
  const controller = new AbortController()
  const command = s.get('/api/commands/exec', { method: 'POST', body: JSON.stringify({ session_id: sid, command: '/probe-choice' }), headers: { 'content-type': 'application/json' }, signal: controller.signal })
  try {
    await admitted
    expect(s.deps.pending.clarifyPending(sid).pending_count).toBe(2)
    if (outcome === 'disconnect') {
      controller.abort()
      await expect(command).rejects.toThrow()
    } else {
      fail()
      expect((await command).status).toBe(503)
    }
    await expect.poll(() => s.deps.pending.clarifyPending(sid).pending_count).toBe(1)
    expect(s.deps.pending.clarifyPending(sid).pending?.clarify_id).toBe('other-command')
    expect(sidecar.calls.filter((c) => c.method === 'commands.exec')).toHaveLength(1)
  } finally { fail(); await command.catch(() => undefined) }
  expect(s.deps.commandSlots.active).toBe(0)
})
