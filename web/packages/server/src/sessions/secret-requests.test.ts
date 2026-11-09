import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIDECAR_SERVER_METHODS } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { Session } from './session.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { loadEnvFile } from '../providers/env-file.js'
import { redactString } from '../redact.js'

type Json = Record<string, unknown>
const fixture = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/secrets.json'), 'utf8')) as Record<'server.secret_request', { params: Json; result: Json }[]>)['server.secret_request'][0]!
const CALLER = '20261109_090000_caller'
// No built-in rule recognizes it: only the saved-value mask hides it.
const SECRET = 'Zq8vR2mN4pL7wX1cK9'

describe('request_secret (TAL-1969)', () => {
  let s: TestServer
  let sidecar: FakeSidecar

  const env = () => loadEnvFile(join(s.state, '.env'))
  const condition = (reply: unknown) => (reply as { error?: { data?: { condition?: string } } }).error?.data?.condition
  /** The agent's call, still waiting; resolves with its result or the server's refusal. */
  const ask = (params: Json = {}) => sidecar.serverRequest('server.secret_request', { ...fixture.params, ...params })
  const head = () => s.deps.pending.clarifyPending(CALLER).pending
  const prompted = async () => {
    await vi.waitFor(() => { expect(head()).not.toBeNull() })
    return head()!
  }
  const respond = async (body: Json, headers: Record<string, string> = {}) => {
    const res = await s.get('/api/clarify/respond', { method: 'POST', body: JSON.stringify({ session_id: CALLER, ...body }), headers: { 'content-type': 'application/json', ...headers } })
    return { status: res.status, body: await res.json() as Json }
  }

  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    sidecar.respond('runtime.env', () => ({ ok: true }))
    const workspace = join(s.state, 'workspace')
    mkdirSync(workspace, { recursive: true })
    await s.deps.sessionStore.save(new Session({ session_id: CALLER, title: 'Report', profile: 'default', workspace, messages: [] }, { workspace, model: null }))
  })
  afterEach(async () => { await s.close() })

  it('shows the prompt, writes the owner\'s answer to the profile .env and returns only the outcome', async () => {
    const reply = ask()
    const pending = await prompted()
    expect(pending.vault).toEqual({ kind: 'agent_secret', backend: null, display_name: null, origin: null, site: null, hint: null,
      secret: { env_name: 'FOO_API_KEY', purpose: fixture.params.purpose, optional: false, existed_before: false },
      fields: [{ key: 'secret', secure: true }], can_answer: true, timeout_at: expect.any(Number) as number })

    expect(await respond({ clarify_id: pending.clarify_id, answers: { secret: SECRET } })).toEqual({ status: 200, body: { ok: true } })
    const result = await reply
    expect(result).toEqual({ jsonrpc: '2.0', id: expect.anything() as unknown, result: fixture.result })
    expect(SIDECAR_SERVER_METHODS['server.secret_request'].result.parse((result as { result: unknown }).result)).toEqual(fixture.result)
    expect(env().FOO_API_KEY).toBe(SECRET)
    expect(head()).toBeNull()
    // The value went only to the .env write and the running sidecar's environment, and the redactor now masks it.
    expect(sidecar.calls.filter((call) => JSON.stringify(call.params).includes(SECRET)).map((call) => call.method).sort()).toEqual(['config.env_write', 'runtime.env'])
    expect(redactString(`Dashboards fetched with ${SECRET} at 09:00`)).toBe('Dashboards fetched with *** at 09:00')
  })

  it('replaces an existing value only when the prompt said it would', async () => {
    writeFileSync(join(s.state, '.env'), 'FOO_API_KEY=old-value-1234\n')
    const replaced = ask()
    const pending = await prompted()
    expect((pending.vault as Json).secret).toMatchObject({ existed_before: true })
    await respond({ clarify_id: pending.clarify_id, answers: { secret: SECRET } })
    expect(await replaced).toMatchObject({ result: { outcome: 'saved', existed_before: true } })
    expect(env().FOO_API_KEY).toBe(SECRET)

    // Set by someone else after a prompt that called it new: kept, and the agent hears why.
    const fresh = ask({ env_name: 'BAR_API_KEY' })
    const second = await prompted()
    writeFileSync(join(s.state, '.env'), 'FOO_API_KEY=x\nBAR_API_KEY=set-meanwhile\n')
    expect((await respond({ clarify_id: second.clarify_id, answers: { secret: SECRET } })).status).toBe(409)
    expect(condition(await fresh)).toBe('env_name_changed')
    expect(env().BAR_API_KEY).toBe('set-meanwhile')
  })

  it('keeps the first of two overlapping saves of a new name and refuses the second', async () => {
    const other = '20261109_090000_other'
    const workspace = join(s.state, 'workspace')
    await s.deps.sessionStore.save(new Session({ session_id: other, title: 'Other', profile: 'default', workspace, messages: [] }, { workspace, model: null }))
    const first = ask()
    const second = sidecar.serverRequest('server.secret_request', { ...fixture.params, caller_session_id: other })
    const [a, b] = [await prompted(), await vi.waitFor(() => { const head = s.deps.pending.clarifyPending(other).pending; expect(head).not.toBeNull(); return head! })]
    const post = (sid: string, clarifyId: unknown, secret: string) => s.get('/api/clarify/respond', { method: 'POST', body: JSON.stringify({ session_id: sid, clarify_id: clarifyId, answers: { secret } }), headers: { 'content-type': 'application/json' } })
    const statuses = (await Promise.all([post(CALLER, a.clarify_id, SECRET), post(other, b.clarify_id, 'Yt7uW3kQ9zR5mP2xL6')])).map((res) => res.status)
    expect(statuses).toEqual([200, 409])
    expect(await first).toMatchObject({ result: { outcome: 'saved' } })
    expect(condition(await second)).toBe('env_name_changed')
    expect(env().FOO_API_KEY).toBe(SECRET)
  })

  it('refuses a malformed or reserved name before any prompt', async () => {
    for (const [name, refused] of [['foo_key', 'env_name_invalid'], ['AB', 'env_name_invalid'], ['HERMES_API_KEY', 'env_name_reserved'], ['TERMINAL_SSH_KEY', 'env_name_reserved'], ['API_SERVER_KEY', 'env_name_reserved'], ['HERMES_WEBUI_SECRET', 'env_name_reserved'],
      // Only a credential's name: never a loader, shell or launch hook, a path, a password prompt or an access list.
      ['BASH_ENV', 'env_name_reserved'], ['NODE_OPTIONS', 'env_name_reserved'], ['GIT_SSH_COMMAND', 'env_name_reserved'], ['PATH', 'env_name_reserved'], ['SUDO_PASSWORD', 'env_name_reserved'], ['TELEGRAM_ALLOWED_USERS', 'env_name_reserved']] as const) {
      // A name the server accepted would show a prompt that times out; a refused one never prompts.
      expect(condition(await ask({ env_name: name, timeout_seconds: 1 })), name).toBe(refused)
    }
    expect(condition(await ask({ purpose: '  ' }))).toBe('purpose_required')
    expect(head()).toBeNull()
  })

  it('writes nothing on a decline, a timeout or a Stop', async () => {
    const declined = ask()
    await respond({ clarify_id: (await prompted()).clarify_id, decline: true })
    expect(await declined).toMatchObject({ result: { outcome: 'declined' } })

    const expired = ask({ timeout_seconds: 1 })
    await prompted()
    expect(await expired).toMatchObject({ result: { outcome: 'timed_out' } })
    expect(head()).toBeNull()

    const stopped = ask()
    await prompted()
    s.deps.pending.clearClarifies(CALLER)
    expect(await stopped).toMatchObject({ result: { outcome: 'declined' } })
    expect(env().FOO_API_KEY).toBeUndefined()
  })

  it('rolls back a refused write and hands the agent the reason', async () => {
    sidecar.respond('config.env_write', () => { throw new SidecarError('API key must not contain spaces, quotes, \'#\' or non-ASCII characters.', { code: -32602, condition: 'invalid_params' }) })
    const refused = ask()
    const response = await respond({ clarify_id: (await prompted()).clarify_id, answers: { secret: 'has a space' } })
    expect(response.status).toBe(400)
    const reply = await refused as { error: { message: string } }
    expect(reply.error.message).toContain('must not contain spaces')
    expect(env().FOO_API_KEY).toBeUndefined()
    // The running sidecar got the value first and then lost it again.
    expect(sidecar.calls.filter((call) => call.method === 'runtime.env').map((call) => call.params)).toEqual([{ set: { FOO_API_KEY: 'has a space' } }, { unset: ['FOO_API_KEY'] }])
  })
})

describe('request_secret for a non-owner (TAL-1969)', () => {
  it('shows the prompt without its field and refuses the answer', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar, env: { HERMES_WEBUI_PASSWORD: 'synthetic-test-password' } })
    sidecar.respond('runtime.env', () => ({ ok: true }))
    const login = (boundProfile?: string) => {
      const value = s.deps.auth.createSession({ authType: 'password', ...(boundProfile ? { boundProfile } : {}) })
      return { cookie: `${s.deps.auth.cookieName()}=${value}`, origin: s.base, 'x-csrf-token': s.deps.auth.csrfTokenForSession(value) ?? '' }
    }
    try {
      const workspace = join(s.state, 'workspace')
      mkdirSync(workspace, { recursive: true })
      await s.deps.sessionStore.save(new Session({ session_id: CALLER, title: 'Report', profile: 'default', workspace, messages: [] }, { workspace, model: null }))
      const reply = sidecar.serverRequest('server.secret_request', fixture.params)
      await vi.waitFor(() => { expect(s.deps.pending.clarifyPending(CALLER).pending).not.toBeNull() })
      const read = async (headers: Record<string, string>) => (await (await s.get(`/api/clarify/pending?session_id=${CALLER}`, { headers })).json() as { pending: { clarify_id: string; vault: Json } }).pending
      const guest = login('default')
      const seen = await read(guest)
      expect(seen.vault).toMatchObject({ kind: 'agent_secret', fields: [], can_answer: false, secret: { env_name: 'FOO_API_KEY' } })
      const post = (headers: Record<string, string>) => s.get('/api/clarify/respond', { method: 'POST', body: JSON.stringify({ session_id: CALLER, clarify_id: seen.clarify_id, answers: { secret: SECRET } }), headers: { 'content-type': 'application/json', ...headers } })
      expect((await post(guest)).status).toBe(403)
      expect(loadEnvFile(join(s.state, '.env')).FOO_API_KEY).toBeUndefined()

      const owner = login()
      expect((await read(owner)).vault).toMatchObject({ fields: [{ key: 'secret', secure: true }], can_answer: true })
      expect((await post(owner)).status).toBe(200)
      expect(await reply).toMatchObject({ result: { outcome: 'saved' } })
    } finally {
      await s.close()
    }
  })
})
