import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'

const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.close() })
const post = (s: TestServer, path: string, body: unknown) => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const warning = { kind: 'data_policy', title: 'Data-Training Tier Warning', model: 'contributor', provider: 'custom', message: 'This model may use your conversation for training.' }
async function setup() {
  const sidecar = new FakeSidecar()
  sidecar.respond('models.selection_warnings', (() => ({ warnings: [warning], context_tokens: 200_000, provider: 'custom', base_url: 'https://provider.invalid/v1' })))
  const s = await bootTestServer({ sidecar }); servers.push(s)
  const created = await (await post(s, '/api/session/new', { model: 'old-model', model_provider: 'custom' })).json() as { session: { session_id: string } }
  const sid = created.session.session_id
  const session = await s.deps.sessionStore.get(sid)
  session.last_prompt_tokens = 200_000; session.context_length = 300_000
  await s.deps.sessionStore.save(session)
  const evict = vi.spyOn(s.deps.sessions.deps.runtime, 'evictAgent')
  const update = (extra = {}) => post(s, '/api/session/update', { session_id: sid, model: 'contributor', model_provider: 'custom', ...extra })
  return { s, sidecar, sid, session, evict, update }
}

describe('guarded model switches (TAL-1042)', () => {
  it('holds old clients without changing model, context or cached Agent, then applies once on confirmation', async () => {
    const { s, sid, session, evict, update } = await setup()
    const held = await update()
    expect(held.status).toBe(409)
    const body = await held.json() as { type: string; warnings: unknown[]; confirm_token: string }
    expect(body).toMatchObject({ type: 'model_confirmation_required', warnings: [warning] })
    expect(body.confirm_token).toBeTruthy()
    expect(session).toMatchObject({ model: 'old-model', last_prompt_tokens: 200_000, context_length: 300_000 })
    expect(evict).not.toHaveBeenCalled()
    expect((await s.deps.sessionStore.get(sid)).model).toBe('old-model')
    expect((await update()).status).toBe(409)
    const applied = await update({ confirm_token: body.confirm_token })
    expect(applied.status).toBe(200)
    expect(await applied.json()).toMatchObject({ session: { model: 'contributor' } })
    expect(evict).toHaveBeenCalledTimes(1)
    expect((await update({ confirm_token: body.confirm_token })).status).toBe(200)
    expect(evict).toHaveBeenCalledTimes(1)
  })

  it('invalidates tokens after context, endpoint or current model changes, and across sessions', async () => {
    const { s, sidecar, session, update, evict } = await setup()
    const held = await (await update()).json() as { confirm_token: string }
    session.last_prompt_tokens = 250_000
    expect((await update({ confirm_token: held.confirm_token })).status).toBe(409)
    session.last_prompt_tokens = 200_000
    sidecar.respond('models.selection_warnings', (() => ({ warnings: [warning], context_tokens: 200_000, provider: 'custom', base_url: 'https://changed.invalid/v1' })))
    expect((await update({ confirm_token: held.confirm_token })).status).toBe(409)
    const other = await (await post(s, '/api/session/new', { model: 'old-model' })).json() as { session: { session_id: string } }
    expect((await update({ session_id: other.session.session_id, confirm_token: held.confirm_token })).status).toBe(409)
    sidecar.respond('models.selection_warnings', () => ({ warnings: [{ ...warning, kind: 'cost', message: 'This model costs more.' }], context_tokens: 200_000, provider: 'custom', base_url: 'https://provider.invalid/v1' }))
    expect((await update({ confirm_token: held.confirm_token })).status).toBe(409)
    sidecar.respond('models.selection_warnings', () => ({ warnings: [warning], context_tokens: 200_000, provider: 'custom', base_url: 'https://provider.invalid/v1' }))
    expect((await update({ model: 'another-target', confirm_token: held.confirm_token })).status).toBe(409)
    expect((await update({ model_provider: 'another-provider', confirm_token: held.confirm_token })).status).toBe(409)
    session.model = 'concurrent-model'
    expect((await update({ confirm_token: held.confirm_token })).status).toBe(409)
    expect(evict).not.toHaveBeenCalled()
  })

  it('preserves the old choice when guard evaluation fails, while neutral selections apply', async () => {
    const { sidecar, session, update, evict } = await setup()
    sidecar.respond('models.selection_warnings', (() => { throw new Error('Guard unavailable') }))
    expect((await update()).status).toBe(503)
    expect(session.model).toBe('old-model'); expect(evict).not.toHaveBeenCalled()
    sidecar.respond('models.selection_warnings', (() => ({ warnings: [], context_tokens: null, provider: 'custom', base_url: '' })))
    expect((await update()).status).toBe(200)
    expect(session.model).toBe('contributor'); expect(evict).toHaveBeenCalledTimes(1)
  })
})

it('binds confirmation to the profile and serializes duplicate confirmations', async () => {
  const { s, session, update, evict } = await setup()
  const held = await (await update()).json() as { confirm_token: string }
  const profile = session.profile
  session.profile = 'foreign'
  await expect(s.deps.sessions.update(session.session_id, { model: 'contributor', model_provider: 'custom', confirm_token: held.confirm_token })).rejects.toMatchObject({ status: 409 })
  session.profile = profile
  const applied = await Promise.all([update({ confirm_token: held.confirm_token }), update({ confirm_token: held.confirm_token })])
  expect(applied.map((r) => r.status)).toEqual([200, 200])
  expect(evict).toHaveBeenCalledTimes(1)
})

it('rechecks context that changes while the Agent guard is answering', async () => {
  const { sidecar, session, update, evict } = await setup()
  const held = await (await update()).json() as { confirm_token: string }
  sidecar.respond('models.selection_warnings', (params) => {
    if (params.context_tokens === 200_000) session.last_prompt_tokens = 250_000
    return { warnings: [warning], context_tokens: params.context_tokens, provider: 'custom', base_url: 'https://provider.invalid/v1' }
  })
  const fresh = await update({ confirm_token: held.confirm_token })
  expect(fresh.status).toBe(409)
  expect(session.model).toBe('old-model'); expect(evict).not.toHaveBeenCalled()
  const body = await fresh.json() as { confirm_token: string }
  expect((await update({ confirm_token: body.confirm_token })).status).toBe(200)
  expect(evict).toHaveBeenCalledTimes(1)
})
