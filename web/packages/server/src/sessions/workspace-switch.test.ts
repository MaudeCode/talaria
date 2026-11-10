import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { useJsonStorage } from '../test/storage.js'

useJsonStorage()

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

/** TAL-2155: `new_chat_on_workspace_switch` makes the server start a fresh chat instead of moving one that has messages. */
describe('workspace switch on session update', () => {
  let s: TestServer
  let first: string
  let second: string
  beforeAll(async () => {
    s = await bootTestServer({ sidecar: new FakeSidecar() })
    first = join(s.state, 'workspace', 'switch-a')
    second = join(s.state, 'workspace', 'switch-b')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    first = realpathSync(first)
    second = realpathSync(second)
  })
  afterAll(() => s.close())

  const chat = async (messages: Json[]): Promise<string> => {
    const sid = String(((await json(await post(s, '/api/session/new', { workspace: first }))).session as Json).session_id)
    const session = await s.deps.sessionStore.get(sid)
    session.messages = messages
    session.project_id = 'proj-switch'
    session.model = 'switch-model'
    session.model_provider = 'switch-provider'
    await s.deps.sessionStore.save(session)
    return sid
  }
  const update = async (sid: string, workspace: string, accept = true): Promise<Json> => {
    const res = await post(s, '/api/session/update', { session_id: sid, workspace, ...(accept ? { accept_switched_to: true } : {}) })
    const body = await json(res)
    expect(res.status, JSON.stringify(body)).toBe(200)
    return body
  }
  const setting = (on: boolean) => s.deps.settings.save({ new_chat_on_workspace_switch: on })

  it('with the setting on, a chat with messages stays put and a new chat takes the chosen workspace', async () => {
    await setting(true)
    const sid = await chat([{ role: 'user', content: 'hi' }])
    const body = await update(sid, second)
    expect(body.switched_to).toEqual(expect.any(String))
    expect(body.switched_to).not.toBe(sid)
    expect((await s.deps.sessionStore.get(sid)).workspace).toBe(first)
    const created = await s.deps.sessionStore.get(String(body.switched_to))
    expect({ workspace: created.workspace, profile: created.profile, project_id: created.project_id, model: created.model, model_provider: created.model_provider, messages: created.messages })
      .toEqual({ workspace: second, profile: (await s.deps.sessionStore.get(sid)).profile, project_id: 'proj-switch', model: 'switch-model', model_provider: 'switch-provider', messages: [] })
    expect((body.session as Json).session_id).toBe(body.switched_to)
  })

  it.each([
    ['the setting is off', false, [{ role: 'user', content: 'hi' }], 'second', true],
    ['the chat is empty', true, [], 'second', true],
    ['the workspace is unchanged', true, [{ role: 'user', content: 'hi' }], 'first', true],
    ['the client cannot follow a switch', true, [{ role: 'user', content: 'hi' }], 'second', false],
  ])('updates in place when %s', async (_case, on, messages, target, accept) => {
    await setting(on)
    const sid = await chat(messages)
    const workspace = target === 'first' ? first : second
    const body = await update(sid, workspace, accept)
    expect(body).not.toHaveProperty('switched_to')
    expect((body.session as Json).session_id).toBe(sid)
    expect((await s.deps.sessionStore.get(sid)).workspace).toBe(workspace)
  })
})
