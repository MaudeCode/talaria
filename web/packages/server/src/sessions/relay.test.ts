import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { loadRelayConfig, PRESENCE_LEASE_SECONDS, PresenceLeases, profileIdentity, RelayPairingError, RelayPublisher, validatedOrigin, type RelayConfig } from './relay.js'

type Json = Record<string, unknown>
const RELAY = 'https://relay.talaria.kil.dev'
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

interface Captured { method: string; url: string; body: Json; headers: Record<string, string> }
interface FakeRelay { calls: Captured[]; snapshotStatus: number; viewedStatus: number; failOnly: string | null; snapshots: () => Captured[]; views: () => Captured[]; publicKey: Buffer | null; fetch: typeof fetch }

function fakeRelay(): FakeRelay {
  const relay: FakeRelay = {
    calls: [], snapshotStatus: 200, viewedStatus: 200, failOnly: null, publicKey: null,
    snapshots: () => relay.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/snapshot')),
    views: () => relay.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/viewed')),
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Json
      const call = { method: init?.method ?? 'GET', url, body, headers }
      relay.calls.push(call)
      if (url.endsWith('/v1/pairings/publisher/redeem')) {
        relay.publicKey = Buffer.from(String(body.publicKey), 'base64url')
        return Promise.resolve(Response.json({ protocolVersion: 2, keyId: 'key-1', publisherId: body.publisherId, profileId: body.profileId, profileIdPreserved: false }))
      }
      if (url.endsWith('/v1/pairings/profile/redeem')) return Promise.resolve(Response.json({ protocolVersion: 2, publisherId: body.publisherId, profileId: body.profileId }))
      if (call.method === 'PUT' && url.endsWith('/viewed')) return Promise.resolve(new Response(relay.viewedStatus === 200 ? '{}' : 'nope', { status: relay.viewedStatus }))
      if (call.method === 'PUT') {
        const status = relay.failOnly && !url.includes(relay.failOnly) ? 200 : relay.snapshotStatus
        return Promise.resolve(new Response(status === 200 ? '{}' : 'nope', { status }))
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    },
  }
  return relay
}

function verifySigned(relay: FakeRelay, call: Captured, path: string): void {
  const raw = JSON.stringify(call.body)
  expect(call.url).toBe(RELAY + path)
  const signed = [call.method, path, call.headers['x-talaria-timestamp'], call.headers['x-talaria-nonce'], createHash('sha256').update(raw, 'utf8').digest('base64url')].join('\n')
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: relay.publicKey!.toString('base64url') }, format: 'jwk' })
  expect(cryptoVerify(null, Buffer.from(signed, 'utf8'), key, Buffer.from(call.headers['x-talaria-signature'] ?? '', 'base64url'))).toBe(true)
  expect(call.headers['x-talaria-key-id']).toBe('key-1')
}

describe('Talaria relay pairing and publishing', () => {
  let s: TestServer
  let relay: FakeRelay
  beforeAll(async () => {
    s = await bootTestServer()
    relay = fakeRelay()
    s.deps.fetch = relay.fetch
  })
  afterAll(() => { s.deps.relay.stop(); return s.close() })

  it('rejects untrusted relays and malformed fields before touching the network', async () => {
    expect((await post(s, '/api/talaria/relay/pair', { relay_url: 'https://evil.example', publisher_id: 'https://pub.example', publisher_invitation: 'inv' })).status).toBe(400)
    expect((await post(s, '/api/talaria/relay/pair', { relay_url: RELAY, publisher_id: 'https://pub.example/path', publisher_invitation: 'inv' })).status).toBe(400)
    expect((await post(s, '/api/talaria/relay/pair', { relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: '' })).status).toBe(400)
    expect(relay.calls).toHaveLength(0)
  })

  it('registers the publisher, persists the key at 0600, and publishes a signed initial snapshot', async () => {
    const res = await post(s, '/api/talaria/relay/pair', { relay_url: RELAY + '/', publisher_id: 'https://pub.example', publisher_invitation: 'invite-1', label: 'Test box' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, publisher_id: 'https://pub.example' })
    const redeem = relay.calls[0]!
    expect(redeem.body).toMatchObject({ invitation: 'invite-1', publisherId: 'https://pub.example', label: 'Test box' })
    expect(String(redeem.body.profileId)).toMatch(/^prf_[0-9a-f]{32}$/)
    const config = loadRelayConfig(s.state)!
    expect(config).toMatchObject({ url: RELAY, publisher_id: 'https://pub.example', key_id: 'key-1' })
    expect(config.profiles.default).toEqual({ identity: profileIdentity(s.state), profile_id: redeem.body.profileId })
    expect(statSync(config.private_key_path).mode & 0o777).toBe(0o600)
    expect(readFileSync(config.private_key_path, 'utf8')).toContain('BEGIN PRIVATE KEY')
    expect(Object.keys(JSON.parse(readFileSync(join(s.state, 'talaria-relay.json'), 'utf8')) as Json)).toEqual(['key_id', 'private_key_path', 'profiles', 'publisher_id', 'url', 'version'])
    const snapshot = relay.snapshots()[0]!
    verifySigned(relay, snapshot, `/v1/publishers/${encodeURIComponent('https://pub.example')}/profiles/${String(redeem.body.profileId)}/snapshot`)
    expect(String(snapshot.body.snapshotId)).toMatch(/^webui:[0-9a-f]{32}$/)
    expect(snapshot.body.states).toEqual([])
    expect(s.deps.relay.current()).not.toBeNull()
  })

  it('re-pairing to a different relay or publisher answers 409', async () => {
    const res = await post(s, '/api/talaria/relay/pair', { relay_url: RELAY, publisher_id: 'https://other.example', publisher_invitation: 'x' })
    expect(res.status).toBe(409)
  })

  it('publishes active runs, pending prompts, and terminal phases for the enrolled profile', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', { title: 'Relay run' }))).session as Json).session_id)
    const before = relay.snapshots().length
    s.deps.registry.activeRuns.set('stream-a', { stream_id: 'stream-a', session_id: sid, started_at: 1, phase: 'agent_starting', workspace: s.state, model: null, provider: null, ephemeral: false })
    s.deps.registry.activeRuns.set('stream-h', { stream_id: 'stream-h', session_id: 'ghost', started_at: 1, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false, health_only: true } as never)
    const publisher = s.deps.relay.current()!
    await publisher.publishSnapshot()
    let states = relay.snapshots()[before]!.body.states as Json[]
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ sessionId: sid, streamId: 'stream-a', phase: 'starting', deepLink: `/sessions/${sid}` })
    expect(String(states[0]!.eventId)).toBe(`snapshot:${String(states[0]!.revision)}:${sid}`)
    expect(states[0]).not.toHaveProperty('alertEligible')
    expect(readFileSync(join(s.state, 'talaria-relay-revision'), 'utf8').trim()).toBe(String(states[0]!.revision))

    s.deps.registry.activeRuns.get('stream-a')!.phase = 'running'
    s.deps.pending.submitApproval(sid, { request_id: 'r1', tool: 'shell' })
    await publisher.publishSnapshot()
    states = relay.snapshots().at(-1)!.body.states as Json[]
    expect(states[0]!.phase).toBe('waiting_for_approval')
    s.deps.pending.resolveApproval(sid, 'r1')

    // A browser lease on the profile mutes alerts for every transition in the snapshot.
    expect(await json(await post(s, '/api/talaria/presence', { tab_id: 'tab_00000001', active: true, seq: 1 }))).toEqual({ ok: true, lease_seconds: PRESENCE_LEASE_SECONDS })
    await publisher.publishSnapshot()
    expect((relay.snapshots().at(-1)!.body.states as Json[])[0]!.alertEligible).toBe(false)
    expect(await json(await post(s, '/api/talaria/presence', { tab_id: 'tab_00000001', active: false, seq: 2 }))).toEqual({ ok: true, lease_seconds: 0 })

    // Terminal state outlives the active-run teardown.
    s.deps.relay.noteTerminal('stream-a', 'completed')
    s.deps.registry.activeRuns.delete('stream-a')
    await publisher.publishSnapshot()
    states = relay.snapshots().at(-1)!.body.states as Json[]
    expect(states[0]).toMatchObject({ sessionId: sid, phase: 'completed' })
    expect(states[0]).not.toHaveProperty('alertEligible')
    s.deps.registry.activeRuns.delete('stream-h')
  })

  it('acknowledges a viewed session on the relay after the snapshot carrying its terminal state', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', { title: 'Viewed run' }))).session as Json).session_id)
    const profileId = loadRelayConfig(s.state)!.profiles.default!.profile_id
    s.deps.registry.activeRuns.set('stream-v', { stream_id: 'stream-v', session_id: sid, started_at: 1, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false })
    s.deps.relay.noteTerminal('stream-v', 'completed')
    s.deps.registry.activeRuns.delete('stream-v')
    const before = relay.calls.length
    const res = await post(s, '/api/talaria/viewed', { session_id: sid })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true })
    await vi.waitFor(() => { expect(relay.views().some((c) => c.url.includes(sid))).toBe(true) })
    const calls = relay.calls.slice(before)
    const viewedIndex = calls.findIndex((c) => c.url.endsWith(`/sessions/${sid}/viewed`))
    const snapshot = calls.slice(0, viewedIndex).reverse().find((c) => c.url.endsWith('/snapshot'))!
    const terminal = (snapshot.body.states as Json[]).find((state) => state.sessionId === sid)!
    expect(terminal.phase).toBe('completed')
    const viewed = calls[viewedIndex]!
    verifySigned(relay, viewed, `/v1/publishers/${encodeURIComponent('https://pub.example')}/profiles/${profileId}/sessions/${sid}/viewed`)
    expect(Object.keys(viewed.body)).toEqual(['through'])
    expect(Number(viewed.body.through)).toBeGreaterThanOrEqual(Number(terminal.updatedAt))
    expect((await post(s, '/api/talaria/viewed', { session_id: 'missing_session_0001' })).status).toBe(404)
  })

  it('clears a deleted session\'s finished runs on the relay, and an already-deleted one when it is requested', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', { title: 'Deleted run' }))).session as Json).session_id)
    const profileId = loadRelayConfig(s.state)!.profiles.default!.profile_id
    s.deps.registry.activeRuns.set('stream-d', { stream_id: 'stream-d', session_id: sid, started_at: 1, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false })
    s.deps.relay.noteTerminal('stream-d', 'completed')
    s.deps.registry.activeRuns.delete('stream-d')
    await vi.waitFor(() => { expect(relay.snapshots().some((c) => (c.body.states as Json[]).some((state) => state.sessionId === sid && state.phase === 'completed'))).toBe(true) })
    const deletedAt = Date.now()
    expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
    const viewedPath = `/v1/publishers/${encodeURIComponent('https://pub.example')}/profiles/${profileId}/sessions/${sid}/viewed`
    await vi.waitFor(() => { expect(relay.views().filter((c) => c.url.endsWith(viewedPath))).toHaveLength(1) })
    const viewed = relay.views().find((c) => c.url.endsWith(viewedPath))!
    verifySigned(relay, viewed, viewedPath)
    expect(Number(viewed.body.through)).toBeGreaterThanOrEqual(deletedAt)

    // A run left behind by a deletion before this fix clears the first time a client asks for the session.
    expect((await s.get(`/api/session?session_id=${sid}&messages=0`)).status).toBe(404)
    await vi.waitFor(() => { expect(relay.views().filter((c) => c.url.endsWith(viewedPath))).toHaveLength(2) })
    const viewsBefore = relay.views().length
    expect((await s.get('/api/session?session_id=never_existed_0001&messages=0')).status).toBe(404)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(relay.views().length).toBe(viewsBefore)
  })

  it('validates presence payloads and ignores stale sequence numbers', async () => {
    expect((await post(s, '/api/talaria/presence', { tab_id: 'short', active: true, seq: 1 })).status).toBe(400)
    expect((await post(s, '/api/talaria/presence', { tab_id: 'tab_00000002', active: 'yes', seq: 1 })).status).toBe(400)
    expect((await post(s, '/api/talaria/presence', { tab_id: 'tab_00000002', active: true, seq: 1.5 })).status).toBe(400)
    let now = 1000
    const leases = new PresenceLeases(() => now)
    leases.renew('default', 'tab_00000003', 5)
    leases.revoke('default', 'tab_00000003', 3)
    expect(leases.has('default')).toBe(true)
    leases.revoke('default', 'tab_00000003', 6)
    expect(leases.has('default')).toBe(false)
    leases.renew('default', 'tab_00000003', 4)
    expect(leases.has('default')).toBe(false)
    leases.renew('work', 'tab_00000004', 1)
    now += PRESENCE_LEASE_SECONDS + 1
    expect(leases.has('work')).toBe(false)
  })

  it('enrolls another profile with a signed request on the existing key', async () => {
    const config = loadRelayConfig(s.state)!
    const before = relay.calls.length
    await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'invite-2' }, 'default', false)
    const redeem = relay.calls[before]!
    verifySigned(relay, redeem, '/v1/pairings/profile/redeem')
    expect(redeem.body).toEqual({ invitation: 'invite-2', publisherId: 'https://pub.example', profileId: config.profiles.default!.profile_id })
    expect(loadRelayConfig(s.state)!.profiles.default).toEqual(config.profiles.default)
  })

  it('surfaces relay rejections as 409/502 without persisting a broken registration', async () => {
    relay.snapshotStatus = 503
    const before = loadRelayConfig(s.state)!
    await expect(s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'invite-3' }, 'default', true)).rejects.toMatchObject({ status: 502 })
    expect(loadRelayConfig(s.state)).toEqual(before)
    relay.snapshotStatus = 200
  })
})

describe('relay publisher failure handling', () => {
  it('isolates a permanent failure to one profile and raises retryable ones', async () => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      const base = loadRelayConfig(s.state)!
      const config: RelayConfig = { ...base, profiles: { ...base.profiles, other: { identity: '', profile_id: 'prf_other' } } }
      const publisher = new RelayPublisher(config, { registry: s.deps.registry, pending: s.deps.pending, store: s.deps.sessionStore, presence: s.deps.relay.presence, profileHome: s.deps.profileHome, profilesMatch: s.deps.profilesMatch, fetch: () => s.deps.fetch, now: () => Date.now() / 1000, log: (l) => s.logs.push(l) })
      relay.failOnly = 'prf_other'
      relay.snapshotStatus = 403
      await publisher.publishSnapshot(true)
      expect(relay.snapshots().filter((c) => c.url.includes('prf_other'))).toHaveLength(1)
      relay.snapshotStatus = 200
      await publisher.publishSnapshot(true)
      expect(relay.snapshots().filter((c) => c.url.includes('prf_other'))).toHaveLength(1)
      expect(s.logs.some((l) => l.includes('disabled profile after permanent HTTP 403'))).toBe(true)
      relay.failOnly = null
      relay.snapshotStatus = 503
      await expect(publisher.publishSnapshot(true)).rejects.toThrow('HTTP 503')
      await expect(publisher.publishSnapshot()).rejects.toThrow('HTTP 503')
    } finally {
      s.deps.relay.stop()
      await s.close()
    }
  })

  it('stamps a terminal row with the moment its turn ended, not the snapshot build time', async () => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      let clock = 1_800_000_000
      const publisher = new RelayPublisher(loadRelayConfig(s.state)!, { registry: s.deps.registry, pending: s.deps.pending, store: s.deps.sessionStore, presence: s.deps.relay.presence, profileHome: s.deps.profileHome, profilesMatch: s.deps.profilesMatch, fetch: () => s.deps.fetch, now: () => clock, log: (l) => s.logs.push(l) })
      const sid = String(((await json(await post(s, '/api/session/new', { title: 'Ended run' }))).session as Json).session_id)
      s.deps.registry.activeRuns.set('stream-t', { stream_id: 'stream-t', session_id: sid, started_at: 1, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false })
      publisher.noteTerminal('stream-t', 'completed')
      s.deps.registry.activeRuns.delete('stream-t')
      clock += 5
      await publisher.publishSnapshot()
      expect((relay.snapshots().at(-1)!.body.states as Json[])[0]).toMatchObject({ sessionId: sid, phase: 'completed', updatedAt: 1_800_000_000_000 })
    } finally {
      s.deps.relay.stop()
      await s.close()
    }
  })

  it('treats viewed as a no-op without a relay and logs an old relay once', async () => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    try {
      const sid = String(((await json(await post(s, '/api/session/new', { title: 'Unpaired' }))).session as Json).session_id)
      expect(await json(await post(s, '/api/talaria/viewed', { session_id: sid }))).toEqual({ ok: true })
      expect(relay.calls).toHaveLength(0)
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      relay.viewedStatus = 404
      for (let i = 0; i < 2; i++) {
        expect(await json(await post(s, '/api/talaria/viewed', { session_id: sid }))).toEqual({ ok: true })
        await vi.waitFor(() => { expect(relay.views()).toHaveLength(i + 1) })
      }
      await vi.waitFor(() => { expect(s.logs.filter((l) => l.includes('does not support viewed acknowledgements'))).toHaveLength(1) })
      expect(s.deps.relay.current()).not.toBeNull()
    } finally {
      s.deps.relay.stop()
      await s.close()
    }
  })

  it('requires an owner registration before profile enrollment and refuses v1 state', async () => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    try {
      await expect(s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', false)).rejects.toMatchObject({ status: 409 })
      expect(relay.calls).toHaveLength(0)
      expect(s.deps.relay.start()).toBe(false)
      expect(existsSync(join(s.state, 'talaria-relay.json'))).toBe(false)
    } finally {
      await s.close()
    }
  })

  it('validatedOrigin and RelayPairingError mirror the Python guards', () => {
    expect(validatedOrigin('https://a.example/')).toBe('https://a.example')
    expect(() => validatedOrigin('http://a.example', true)).toThrow('HTTPS origin')
    expect(() => validatedOrigin('https://u:p@a.example')).toThrow()
    expect(() => validatedOrigin('https://a.example/x')).toThrow()
    expect(new RelayPairingError('m', 409).status).toBe(409)
  })
})
