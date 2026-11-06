import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'

const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.close() })
const post = (s: TestServer, path: string, body: unknown) => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const parsed = (fields: Record<string, unknown>) => ({ target: '', provider: null, reset: false, reasoning: null, errors: [], unsupported_flags: [], ...fields })

async function setup(model: unknown = { default: 'profile-model', provider: 'profile-provider' }) {
  const sidecar = new FakeSidecar()
  const s = await bootTestServer({ sidecar }); servers.push(s)
  writeFileSync(join(s.state, 'config.yaml'), 'model: {}\n')
  sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { model } }))
  const created = await (await post(s, '/api/session/new', { model: 'pinned-model', model_provider: 'pinned-provider' })).json() as { session: { session_id: string } }
  const sid = created.session.session_id
  const command = (args: string, session_id: string | null = sid) => post(s, '/api/session/model-command', { args, ...(session_id ? { session_id } : {}) })
  return { s, sidecar, sid, command }
}

describe('/model arguments (TAL-1814)', () => {
  it('a /model reset write returns a pinned chat to the profile default instead of pinning "reset"', async () => {
    const { s, sid } = await setup()
    const evict = vi.spyOn(s.deps.sessions.deps.runtime, 'evictAgent')
    const response = await post(s, '/api/session/update', { session_id: sid, model: 'reset' })
    expect(await response.json()).toMatchObject({ session: { model: 'profile-model', model_provider: 'profile-provider' } })
    expect(await s.deps.sessionStore.get(sid)).toMatchObject({ model: 'profile-model', model_provider: 'profile-provider' })
    expect(evict).toHaveBeenCalledOnce()
  })

  it('reports the profile default a reset lands on, and the request an owner-run chat must receive', async () => {
    const { sidecar, command } = await setup()
    sidecar.respond('models.parse_switch_args', () => parsed({ target: 'reset', reset: true }))
    expect(await (await command('reset')).json()).toEqual({ model: 'profile-model', model_provider: 'profile-provider', owner_payload: { model: 'reset' } })
    expect(sidecar.calls.filter((c) => c.method === 'models.parse_switch_args').at(-1)?.params).toEqual({ args: 'reset' })
  })

  it.each([
    ['a model and its provider', parsed({ target: 'some/model', provider: 'openrouter' }), { model: 'some/model', model_provider: 'openrouter' }],
    ['a bare id, which keeps today\'s no-provider pick', parsed({ target: 'some/model' }), { model: 'some/model', model_provider: null }],
    ['a provider-qualified id', parsed({ target: '@nous:openai/gpt-5.4-mini' }), { model: 'openai/gpt-5.4-mini', model_provider: 'nous' }],
    ['a provider alone, which keeps the chat\'s model', parsed({ provider: 'openrouter' }), { model: 'pinned-model', model_provider: 'openrouter' }],
  ])('maps %s to the model state', async (_, answer, expected) => {
    const { sidecar, command } = await setup()
    sidecar.respond('models.parse_switch_args', () => answer)
    expect(await (await command('raw arguments')).json()).toEqual(expected)
  })

  it('answers an unsaved chat from the active profile', async () => {
    const { sidecar, command } = await setup()
    sidecar.respond('models.parse_switch_args', () => parsed({ reset: true }))
    expect(await (await command('reset', null)).json()).toMatchObject({ model: 'profile-model', model_provider: 'profile-provider' })
    sidecar.respond('models.parse_switch_args', () => parsed({ provider: 'openrouter' }))
    expect(await (await command('--provider openrouter', null)).json()).toEqual({ model: 'profile-model', model_provider: 'openrouter' })
  })

  it('keeps the model a chat without a local record shows when only a provider is named', async () => {
    const { s, sidecar, sid } = await setup()
    sidecar.respond('models.parse_switch_args', () => parsed({ provider: 'openrouter' }))
    const ask = async (body: Record<string, unknown>) => (await post(s, '/api/session/model-command', { args: '--provider openrouter', ...body })).json()
    expect(await ask({ current_model: 'chosen-before-saving' })).toEqual({ model: 'chosen-before-saving', model_provider: 'openrouter' })
    // A project's unsaved chat shows a qualified id; the named provider still wins over the one inside it.
    expect(await ask({ current_model: '@gemini:gemini-2.5-flash' })).toEqual({ model: 'gemini-2.5-flash', model_provider: 'openrouter' })
    // A chat Web keeps a record of answers from that record, not from what a stale view shows.
    expect(await ask({ session_id: sid, current_model: 'stale-view' })).toEqual({ model: 'pinned-model', model_provider: 'openrouter' })
  })

  it.each([
    ['the Agent\'s own refusal', parsed({ target: 'reset', errors: ['/model reset takes no flags'] }), '/model reset takes no flags'],
    ['a flag Web cannot honor', parsed({ target: 'some/model', reasoning: 'high', unsupported_flags: ['--global'] }), '/model --global, --reasoning is not available here'],
  ])('refuses %s without touching the chat', async (_, answer, message) => {
    const { s, sidecar, sid, command } = await setup()
    sidecar.respond('models.parse_switch_args', () => answer)
    const response = await command('raw arguments')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: message })
    expect(await s.deps.sessionStore.get(sid)).toMatchObject({ model: 'pinned-model', model_provider: 'pinned-provider' })
  })

  it('refuses a reset when the profile names no default, and keeps the pin', async () => {
    const { s, sidecar, sid, command } = await setup({})
    sidecar.respond('models.parse_switch_args', () => parsed({ reset: true }))
    const message = 'This profile has no default model to return to'
    const answer = await command('reset')
    expect(answer.status).toBe(400)
    expect(await answer.json()).toMatchObject({ error: message })
    const write = await post(s, '/api/session/update', { session_id: sid, model: 'reset' })
    expect(write.status).toBe(400)
    expect(await write.json()).toMatchObject({ error: message })
    expect(await s.deps.sessionStore.get(sid)).toMatchObject({ model: 'pinned-model', model_provider: 'pinned-provider' })
  })

  it('reads a default the cached config has not seen yet', async () => {
    const { s, sidecar, sid } = await setup()
    writeFileSync(join(s.state, 'config.yaml'), 'model: {}\n# changed on disk\n')
    sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { model: { default: 'edited-model', provider: 'edited-provider' } } }))
    const response = await post(s, '/api/session/update', { session_id: sid, model: 'reset' })
    expect(await response.json()).toMatchObject({ session: { model: 'edited-model', model_provider: 'edited-provider' } })
  })
})
