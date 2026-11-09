import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIDECAR_SERVER_METHODS } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../../test/harness.js'
import { browserKeys, fakeRelay, stubPushService, type FakeRelay, type Push } from '../../test/notifications.js'
import { Session } from '../session.js'

type Json = Record<string, unknown>
const fixture = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/sidecar/notify.json'), 'utf8')) as Record<'server.notify', { params: Json; result: Json }[]>)['server.notify'][0]!
const CALLER = String(fixture.params.caller_session_id)
const PUSH_PATH = '/api/notifications/web-push/subscriptions'
const RELAY = 'https://relay.talaria.kil.dev'

describe('the notify agent tool (TAL-1970)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let relay: FakeRelay
  let push: ReturnType<typeof stubPushService>
  let clock: number
  const keys = browserKeys()

  const post = (path: string, body: unknown) => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  /** The agent's call: the server's result, or its refusal's condition. */
  const notify = async (params: Json = {}): Promise<Json> => {
    const reply = await sidecar.serverRequest('server.notify', { ...fixture.params, ...params }) as { result?: Json; error?: { data?: { condition?: string } } }
    return reply.result ?? { condition: reply.error?.data?.condition }
  }
  const settle = async (): Promise<void> => { s.deps.notifications.changed(); await s.deps.webPush.idle() }
  const opened = (sent: Push) => keys.decrypt(Buffer.from(sent.init.body as Uint8Array))
  /** The agent notice the Relay's next snapshot carries for the caller, and the row's deep link. */
  const relayed = async () => {
    await s.deps.relay.current()!.publishSnapshot()
    const state = (relay.snapshots().at(-1)!.body.states as Json[]).find((candidate) => candidate.sessionId === CALLER)!
    return { agentNotify: state.agentNotify, deepLink: state.deepLink }
  }

  beforeEach(async () => {
    clock = 1_800_000_000
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, now: () => clock })
    push = stubPushService(s)
    relay = fakeRelay()
    s.deps.fetch = relay.fetch
    expect((await post('/api/talaria/relay/pair', { relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'invite-notify' })).status).toBe(200)
    expect((await post(PUSH_PATH, { endpoint: 'https://push.example/send/notify', keys: { p256dh: keys.p256dh, auth: keys.auth } })).status).toBe(200)
    const workspace = join(s.state, 'workspace')
    mkdirSync(workspace, { recursive: true })
    await s.deps.sessionStore.save(new Session({ session_id: CALLER, title: 'Report', profile: 'default', workspace, messages: [] }, { workspace, model: null }))
    s.deps.registry.activeRuns.set('stream-notify', { stream_id: 'stream-notify', session_id: CALLER, started_at: clock, phase: 'running', workspace, model: null, provider: null, ephemeral: false })
    await settle()
  })
  afterEach(async () => { s.deps.relay.stop(); await s.close() })

  it('sends one alert that opens the session through Web Push and the Relay, and reports each channel', async () => {
    const result = await notify()
    expect(SIDECAR_SERVER_METHODS['server.notify'].result.parse(result)).toEqual({ ...fixture.result, notice_id: expect.stringMatching(/^an_[0-9a-f]{16}$/) as string, channels: { relay: 'sent', 'web-push': 'sent' } })
    await settle()
    expect(push.pushes).toHaveLength(1)
    expect(push.pushes[0]!.init.headers).toMatchObject({ Urgency: 'high' })
    expect(opened(push.pushes[0]!)).toEqual({ title: fixture.params.title, body: fixture.params.body, tag: `notify:${String(result.notice_id)}`, url: `/session/${CALLER}` })
    expect(await relayed()).toEqual({ agentNotify: { id: result.notice_id, title: fixture.params.title, body: fixture.params.body, level: 'attention' }, deepLink: `/sessions/${CALLER}` })
    // Later passes and snapshots carry the same notice, which never alerts again.
    await settle()
    expect(push.pushes).toHaveLength(1)
  })

  it('mutes info while a Talaria tab is attached to the profile, and delivers attention anyway', async () => {
    expect((await post('/api/talaria/presence', { tab_id: 'tab_00000003', active: true, seq: 1 })).status).toBe(200)
    expect(await notify({ level: 'info' })).toMatchObject({ status: 'sent', level: 'info', channels: { relay: 'muted', 'web-push': 'muted' } })
    await settle()
    expect(push.pushes).toHaveLength(0)
    expect((await relayed()).agentNotify).toBeUndefined()

    const attention = await notify({ level: 'attention' })
    expect(attention).toMatchObject({ status: 'sent', channels: { relay: 'sent', 'web-push': 'sent' } })
    await settle()
    expect(push.pushes.map((sent) => opened(sent).tag)).toEqual([`notify:${String(attention.notice_id)}`])
    expect((await relayed()).agentNotify).toMatchObject({ id: attention.notice_id, level: 'attention' })
  })

  it('refuses a sixth notice within 10 minutes and a second attention within a minute, sending nothing', async () => {
    expect(await notify({ level: 'attention' })).toMatchObject({ status: 'sent' })
    clock += 30
    expect(await notify({ level: 'attention' })).toMatchObject({ status: 'rate_limited', notice_id: null, channels: {}, retry_after_seconds: 30 })
    for (let sent = 2; sent <= 5; sent++) {
      clock += 60
      expect(await notify({ level: sent === 2 ? 'attention' : 'info' })).toMatchObject({ status: 'sent' })
    }
    await settle()
    const delivered = push.pushes.length
    const shown = (await relayed()).agentNotify
    clock += 10
    // The first of the five went out 280 seconds ago; the window frees it 320 seconds from now.
    expect(await notify({ level: 'info' })).toMatchObject({ status: 'rate_limited', retry_after_seconds: 320 })
    await settle()
    expect(push.pushes).toHaveLength(delivered)
    expect((await relayed()).agentNotify).toEqual(shown)
    clock += 320
    expect(await notify({ level: 'info' })).toMatchObject({ status: 'sent' })
  })

  it("puts a child run's notice on the parent's row, and reports a session no row shows as unavailable", async () => {
    const workspace = join(s.state, 'workspace')
    await s.deps.sessionStore.save(new Session({ session_id: 'child', title: 'Child', profile: 'default', workspace, messages: [] }, { workspace, model: null }))
    s.deps.registry.activeRuns.set('stream-child', { stream_id: 'stream-child', session_id: 'child', started_at: clock, phase: 'running', workspace, model: null, provider: null, ephemeral: false, activity_parent_session_id: CALLER })
    const child = await notify({ caller_session_id: 'child' })
    expect(child).toMatchObject({ status: 'sent', url: `/session/${CALLER}`, channels: { relay: 'sent', 'web-push': 'sent' } })
    await settle()
    expect(opened(push.pushes.at(-1)!)).toMatchObject({ tag: `notify:${String(child.notice_id)}`, url: `/session/${CALLER}` })
    expect((await relayed()).agentNotify).toMatchObject({ id: child.notice_id })

    s.deps.registry.activeRuns.delete('stream-child')
    s.deps.registry.activeRuns.delete('stream-notify')
    const before = push.pushes.length
    expect(await notify({ level: 'info' })).toMatchObject({ status: 'sent', url: `/session/${CALLER}`, channels: { relay: 'unavailable', 'web-push': 'unavailable' } })
    await settle()
    expect(push.pushes).toHaveLength(before)
  })

  it('refuses a title over 80 or a body over 300 characters before anything is sent', async () => {
    expect(await notify({ title: 'x'.repeat(81) })).toEqual({ condition: 'title_too_long' })
    expect(await notify({ body: 'x'.repeat(301) })).toEqual({ condition: 'body_too_long' })
    expect(await notify({ title: 'x'.repeat(80), body: 'é'.repeat(300) })).toMatchObject({ status: 'sent' })
    await settle()
    expect(push.pushes).toHaveLength(1)
  })
})

describe('the notify agent tool under person isolation (TAL-1970)', () => {
  it("alerts only the session owner's devices", async () => {
    const issuer = 'https://identity.invalid'
    const sidecar = new FakeSidecar()
    const server = await bootTestServer({ sidecar, env: {
      HERMES_WEBUI_PERSON_ISOLATION: '1', HERMES_WEBUI_OIDC_ISSUER: issuer, HERMES_WEBUI_OIDC_CLIENT_ID: 'synthetic-client',
      HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'email_verified', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'true', HERMES_WEBUI_OIDC_OWNER_CLAIM: 'groups', HERMES_WEBUI_OIDC_OWNER_VALUES: 'admins',
    }, deps: (deps) => { deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true) } })
    try {
      const push = stubPushService(server)
      const signIn = (subject: string) => {
        const cookie = server.deps.auth.createSession({ authType: 'oidc', username: subject, oidcBinding: { issuer, subject } })
        return { cookie: `${server.deps.auth.cookieName()}=${cookie}`, origin: server.base, 'X-Hermes-CSRF-Token': server.deps.auth.csrfTokenForSession(cookie)!, 'content-type': 'application/json' }
      }
      const alice = signIn('alice')
      const bob = signIn('bob')
      const keys = browserKeys()
      for (const [headers, endpoint] of [[alice, 'https://push.example/send/alice'], [bob, 'https://push.example/send/bob']] as const) {
        expect((await server.get(PUSH_PATH, { method: 'POST', headers, body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }) })).status).toBe(200)
      }
      const sid = ((await (await server.get('/api/session/new', { method: 'POST', headers: alice, body: '{}' })).json()) as { session: { session_id: string } }).session.session_id
      server.deps.registry.activeRuns.set('stream-alice', { stream_id: 'stream-alice', session_id: sid, started_at: 1, phase: 'running', workspace: server.state, model: null, provider: null, ephemeral: false })
      const settle = async (): Promise<void> => { server.deps.notifications.changed(); await server.deps.webPush.idle() }
      await settle()
      const reply = await sidecar.serverRequest('server.notify', { ...fixture.params, caller_session_id: sid }) as { result: Json }
      // Relay enrollment is per profile, so it never carries a person's session.
      expect(reply.result).toMatchObject({ status: 'sent', channels: { relay: 'unavailable', 'web-push': 'sent' } })
      await settle()
      expect(push.pushes.map((p) => p.url)).toEqual(['https://push.example/send/alice'])
    } finally {
      await server.close()
    }
  })
})
