/**
 * TAL-902: `/refine [focus]` from Web runs the Agent's memory/skill review on the session's agent through
 * `POST /api/commands/exec`; it never starts a model turn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

const TRANSCRIPT: Json[] = [
  { role: 'user', content: 'deploy with the blue script', timestamp: 1 },
  { role: 'assistant', content: 'deployed', timestamp: 2 },
]
const STARTED = '⚗ Reviewing this conversation in the background — any memory/skill updates will be reported when done.'

describe('/refine from Web', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())
  beforeEach(() => {
    sidecar.calls.length = 0
    sidecar.respond('chat.refine', (params) => ({ output: params.focus ? STARTED.replace(' —', ` (focus: ${params.focus}) —`) : STARTED }))
  })

  async function seeded(extra: Json = {}): Promise<string> {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = (await s.deps.sessionStore.get(sid))
    Object.assign(session, { messages: structuredClone(TRANSCRIPT), ...extra })
    await s.deps.sessionStore.save(session)
    return sid
  }
  const exec = async (command: string, sid?: string): Promise<{ status: number; body: Json }> => {
    const res = await post(s, '/api/commands/exec', { command, ...(sid ? { session_id: sid } : {}) })
    return { status: res.status, body: await json(res) }
  }
  const methods = (): string[] => sidecar.calls.map((c) => c.method)

  it('is a command the server runs, so Web never sends it to the model', async () => {
    const commands = (await json(await s.get('/api/commands'))).commands as Json[]
    expect(commands.find((c) => c.name === 'refine')).toMatchObject({ handler: 'agent', clients: ['web', 'ios'], exec: true })
  })

  it('starts the review on the session agent with its model context and focus, without a turn', async () => {
    const sid = await seeded()
    expect(await exec('/refine', sid)).toEqual({ status: 200, body: { output: STARTED } })
    expect(await exec('/refine  keep deploy steps ', sid)).toEqual({ status: 200, body: { output: '⚗ Reviewing this conversation in the background (focus: keep deploy steps) — any memory/skill updates will be reported when done.' } })
    const refines = sidecar.calls.filter((c) => c.method === 'chat.refine').map((c) => c.params as Json)
    expect(refines).toHaveLength(2)
    expect(refines[0]).toMatchObject({ profile_home: s.deps.profileHome('default'), session_id: sid, focus: '', messages: TRANSCRIPT.map(({ role, content }) => ({ role, content })) })
    // TAL-903: the workspace pair a turn sends, so the agent built here is the one the next turn reuses.
    expect(refines[0]).toMatchObject({ workspace: (await s.deps.sessions.turnWorkspace((await s.deps.sessionStore.get(sid)))), workspace_local: true })
    expect(refines[1]).toMatchObject({ focus: 'keep deploy steps' })
    expect(methods()).not.toContain('chat.start')
    expect(methods()).not.toContain('commands.exec')
    expect((await s.deps.sessionStore.get(sid)).messages).toHaveLength(TRANSCRIPT.length)
  })

  it('asks to wait while a turn runs', async () => {
    const sid = await seeded({ active_stream_id: 'stream-1' })
    expect(await exec('/refine', sid)).toEqual({ status: 200, body: { output: 'Agent is running — wait for the turn to finish, then /refine.' } })
    expect(methods()).not.toContain('chat.refine')
  })

  it('has nothing to refine in an empty or unsaved chat', async () => {
    const sid = await seeded({ messages: [] })
    expect(await exec('/refine', sid)).toEqual({ status: 200, body: { output: 'Nothing to refine yet — the conversation is empty.' } })
    expect(await exec('/refine')).toEqual({ status: 200, body: { output: 'Nothing to refine yet — send a message first.' } })
    expect(methods()).not.toContain('chat.refine')
  })
})
