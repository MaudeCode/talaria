import { sessionDirectory, sessionPath } from '../test/storage.js'
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import * as atomic from '../fs/atomic.js'
import { loadRelayConfig, saveRelayConfig, PRESENCE_FENCE_SECONDS, PRESENCE_LEASE_SECONDS, PRESENCE_MAX_LEASES, PresenceLeases, profileIdentity, RelayPairingError, RelayPublisher, validatedOrigin, type RelayConfig } from './relay.js'

type Json = Record<string, unknown>
const RELAY = 'https://relay.talaria.kil.dev'
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const deletedViews = (s: TestServer): Json[] => (JSON.parse(readFileSync(join(s.state, 'talaria-relay-deleted.json'), 'utf8')) as { views: Json[] }).views

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

  it('clears a deleted session\'s finished runs on the relay once, and an orphan left by an earlier deletion on first lookup', async () => {
    const profileId = loadRelayConfig(s.state)!.profiles.default!.profile_id
    const viewedPath = (sid: string): string => `/v1/publishers/${encodeURIComponent('https://pub.example')}/profiles/${profileId}/sessions/${sid}/viewed`
    const viewsOf = (sid: string): Captured[] => relay.views().filter((c) => c.url.endsWith(viewedPath(sid)))
    const finishedSession = async (title: string, stream: string): Promise<string> => {
      const sid = String(((await json(await post(s, '/api/session/new', { title }))).session as Json).session_id)
      s.deps.registry.activeRuns.set(stream, { stream_id: stream, session_id: sid, started_at: 1, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false })
      s.deps.relay.noteTerminal(stream, 'completed')
      s.deps.registry.activeRuns.delete(stream)
      await vi.waitFor(() => { expect(relay.snapshots().some((c) => (c.body.states as Json[]).some((state) => state.sessionId === sid && state.phase === 'completed'))).toBe(true) })
      return sid
    }

    const deleted = await finishedSession('Deleted run', 'stream-d')
    const deletedAt = Date.now()
    expect((await post(s, '/api/session/delete', { session_id: deleted })).status).toBe(200)
    await vi.waitFor(() => { expect(viewsOf(deleted)).toHaveLength(1) })
    verifySigned(relay, viewsOf(deleted)[0]!, viewedPath(deleted))
    expect(Number(viewsOf(deleted)[0]!.body.through)).toBeGreaterThanOrEqual(deletedAt)

    // A deletion from before this fix left its run on the relay; the first lookup of the tombstoned id clears it.
    const orphan = await finishedSession('Orphaned run', 'stream-o')
    expect((await s.deps.sessionStore.delete(orphan))).toBe(true)
    expect((await s.get(`/api/session?session_id=${orphan}&messages=0`)).status).toBe(404)
    await vi.waitFor(() => { expect(viewsOf(orphan)).toHaveLength(1) })

    // Later lookups, an already-cleared deletion, and an id that never existed send nothing more. A real view queued
    // afterwards flushes in the same loop, so once it lands any stray acknowledgement would have landed too.
    expect((await s.get(`/api/session?session_id=${orphan}&messages=0`)).status).toBe(404)
    expect((await s.get(`/api/session?session_id=${deleted}&messages=0`)).status).toBe(404)
    expect((await s.get('/api/session?session_id=neverexisted0001&messages=0')).status).toBe(404)
    const marker = await finishedSession('Marker run', 'stream-m')
    expect((await post(s, '/api/talaria/viewed', { session_id: marker })).status).toBe(200)
    await vi.waitFor(() => { expect(viewsOf(marker)).toHaveLength(1) })
    expect(viewsOf(orphan)).toHaveLength(1)
    expect(viewsOf(deleted)).toHaveLength(1)
    expect(viewsOf('neverexisted0001')).toHaveLength(0)
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

  it('keeps a presence sequence fence after its lease expires', () => {
    let now = 1000
    const leases = new PresenceLeases(() => now)
    leases.renew('default', 'tab_00000005', 9)
    leases.revoke('default', 'tab_00000005', 10)
    now += PRESENCE_LEASE_SECONDS + 1
    leases.renew('default', 'tab_00000005', 9)
    expect(leases.has('default')).toBe(false)
    leases.renew('default', 'tab_00000005', 11)
    expect(leases.has('default')).toBe(true)
    // Fences stay scoped to their profile and tab.
    leases.renew('default', 'tab_00000006', 1)
    leases.renew('work', 'tab_00000005', 1)
    expect(leases.has('work')).toBe(true)
    leases.revoke('default', 'tab_00000005', 12)
    expect(leases.has('default')).toBe(true)
    // A restart starts alert-eligible with no fences.
    expect(new PresenceLeases(() => now).has('default')).toBe(false)
  })

  it('drops a presence fence after its retention so a reloaded tab with an earlier clock recovers', () => {
    let now = 1000
    const leases = new PresenceLeases(() => now)
    leases.revoke('default', 'tab_00000007', 50)
    now += PRESENCE_LEASE_SECONDS + PRESENCE_FENCE_SECONDS - 1
    leases.renew('default', 'tab_00000007', 40)
    expect(leases.has('default')).toBe(false)
    now += 1
    leases.renew('default', 'tab_00000007', 40)
    expect(leases.has('default')).toBe(true)
  })

  it('bounds presence state by evicting the least recently updated tab', () => {
    let now = 1000
    const leases = new PresenceLeases(() => now)
    leases.revoke('default', 'tab_00000000', 5)
    for (let i = 1; i < PRESENCE_MAX_LEASES; i++) leases.revoke('default', `tab_${String(i).padStart(8, '0')}`, 1)
    now += PRESENCE_LEASE_SECONDS + 1
    leases.renew('default', 'tab_00000000', 4)
    expect(leases.has('default')).toBe(false)
    leases.revoke('other', 'tab_99999999', 1)
    leases.renew('default', 'tab_00000000', 4)
    expect(leases.has('default')).toBe(true)
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
  it('retains cleanup when session existence cannot be inspected', async () => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    const sid = 'restricted-deletion'
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      s.deps.relay.stop()
      mkdirSync(sessionDirectory(s.deps.sessionStore), { recursive: true })
      await s.deps.relay.clearDeleted(sid, 'default')
      chmodSync(sessionDirectory(s.deps.sessionStore), 0o000)
      expect(s.deps.relay.start()).toBe(true)
      await vi.waitFor(() => { expect(s.logs.some((line) => line.includes('EACCES')) || relay.views().some((call) => call.url.includes(sid))).toBe(true) })
      expect(relay.views().filter((call) => call.url.includes(sid))).toEqual([])
      expect(deletedViews(s)).toHaveLength(1)
      chmodSync(sessionDirectory(s.deps.sessionStore), 0o700)
      s.deps.relay.current()!.changed()
      await vi.waitFor(() => { expect(deletedViews(s)).toEqual([]) })
      expect(relay.views().filter((call) => call.url.includes(sid))).toHaveLength(1)
    } finally {
      chmodSync(sessionDirectory(s.deps.sessionStore), 0o700)
      s.deps.relay.stop()
      await s.close()
    }
  })

  it.each(['write failure', 'corrupt outbox'])('preserves the session for retry after an outbox %s', async (failure) => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    let restore = (): void => undefined
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      const sid = String(((await json(await post(s, '/api/session/new', { title: 'Retryable delete' }))).session as Json).session_id)
      await s.deps.sessionStore.save((await s.deps.sessionStore.get(sid)))
      const outbox = join(s.state, 'talaria-relay-deleted.json')
      if (failure === 'corrupt outbox') writeFileSync(outbox, '{"version":1,"views":[{"sessionId":"pending"}]}')
      else {
        const write = atomic.atomicWriteText
        const spy = vi.spyOn(atomic, 'atomicWriteText').mockImplementation((path, text, opts) => {
          if (path === outbox) throw new Error('synthetic disk-full failure')
          write(path, text, opts)
        })
        restore = () => { spy.mockRestore() }
      }
      expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(500)
      expect(existsSync(sessionPath(s.deps.sessionStore, sid))).toBe(true)
      expect((await s.deps.sessionStore.get(sid)).profile).toBe('default')
      expect(relay.views().some((call) => call.url.includes(sid))).toBe(false)
      restore()
      if (failure === 'corrupt outbox') rmSync(outbox)
      expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
      await vi.waitFor(() => { expect(relay.views().some((call) => call.url.includes(sid))).toBe(true) })
      await vi.waitFor(() => { expect(deletedViews(s)).toEqual([]) })
    } finally {
      restore()
      s.deps.relay.stop()
      await s.close()
    }
  })

  it('holds a staged deletion through failed removal and Web restart, then covers the successful retry cutoff', async () => {
    let clock = 1_800_000_000
    const s = await bootTestServer({ now: () => clock })
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    let restarted: TestServer | undefined
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      const sid = String(((await json(await post(s, '/api/session/new', { title: 'Failed removal' }))).session as Json).session_id)
      await s.deps.sessionStore.save((await s.deps.sessionStore.get(sid)))
      const remove = vi.spyOn(s.deps.sessionStore, 'delete').mockResolvedValueOnce(false)
      try { expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(500) } finally { remove.mockRestore() }
      expect(deletedViews(s)).toHaveLength(1)
      expect(deletedViews(s)[0]!.through).toBe(clock * 1000)
      s.deps.relay.stop()
      restarted = await bootTestServer({
        env: { HERMES_HOME: s.state, HERMES_WEBUI_STATE_DIR: s.state }, now: () => clock,
        deps: (deps) => { deps.fetch = relay.fetch },
      })
      expect(restarted.deps.relay.start()).toBe(true)
      const marker = String(((await json(await post(restarted, '/api/session/new', { title: 'Replay barrier' }))).session as Json).session_id)
      await post(restarted, '/api/talaria/viewed', { session_id: marker })
      await vi.waitFor(() => { expect(relay.views().some((call) => call.url.includes(marker))).toBe(true) })
      expect(relay.views().some((call) => call.url.includes(sid))).toBe(false)
      expect(existsSync(sessionPath(s.deps.sessionStore, sid))).toBe(true)
      clock += 600
      expect((await post(restarted, '/api/session/delete', { session_id: sid })).status).toBe(200)
      await vi.waitFor(() => { expect(deletedViews(s)).toEqual([]) })
      const calls = relay.views().filter((call) => call.url.includes(sid))
      expect(calls).toHaveLength(1)
      expect(calls[0]!.body.through).toBe(clock * 1000)
    } finally {
      restarted?.deps.relay.stop()
      await restarted?.close()
      s.deps.relay.stop()
      await s.close()
    }
  })

  it('replays deleted-session cleanup after a failed delivery and a Web restart with the original cutoff', async () => {
    let clock = 1_800_000_000
    const s = await bootTestServer({ now: () => clock })
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    let restarted: TestServer | undefined
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      const sid = String(((await json(await post(s, '/api/session/new', { title: 'Deleted during outage' }))).session as Json).session_id)
      const profileId = loadRelayConfig(s.state)!.profiles.default!.profile_id
      s.deps.registry.activeRuns.set('deleted-run', { stream_id: 'deleted-run', session_id: sid, started_at: clock, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false })
      s.deps.relay.noteTerminal('deleted-run', 'completed')
      s.deps.registry.activeRuns.delete('deleted-run')
      await vi.waitFor(() => { expect(relay.snapshots().some((c) => (c.body.states as Json[]).some((state) => state.sessionId === sid && state.phase === 'completed'))).toBe(true) })
      relay.viewedStatus = 503
      expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
      await vi.waitFor(() => { expect(relay.views().some((c) => c.url.includes(sid))).toBe(true) })
      const original = relay.views().find((c) => c.url.includes(sid))!
      expect(original.body.through).toBe(clock * 1000)
      s.deps.relay.stop()
      const before = relay.views().length
      clock += 600
      relay.viewedStatus = 200
      restarted = await bootTestServer({
        env: { HERMES_HOME: s.state, HERMES_WEBUI_STATE_DIR: s.state }, now: () => clock,
        deps: (deps) => { deps.fetch = relay.fetch },
      })
      expect(restarted.deps.relay.start()).toBe(true)
      await vi.waitFor(() => { expect(relay.views().slice(before).some((c) => c.url.includes(sid))).toBe(true) })
      const replay = relay.views().slice(before).find((c) => c.url.includes(sid))!
      verifySigned(relay, replay, `/v1/publishers/${encodeURIComponent('https://pub.example')}/profiles/${profileId}/sessions/${sid}/viewed`)
      expect(replay.body).toEqual(original.body)
      expect(replay.headers['x-talaria-nonce']).not.toBe(original.headers['x-talaria-nonce'])
      await vi.waitFor(() => { expect(deletedViews(s)).toEqual([]) })
      restarted.deps.relay.stop()
      const delivered = relay.views().length
      expect(restarted.deps.relay.start()).toBe(true)
      // A later ordinary view acts as a barrier for another publisher pass.
      const marker = String(((await json(await post(restarted, '/api/session/new', { title: 'Marker' }))).session as Json).session_id)
      await post(restarted, '/api/talaria/viewed', { session_id: marker })
      await vi.waitFor(() => { expect(relay.views().slice(delivered).some((c) => c.url.includes(marker))).toBe(true) })
      expect(relay.views().slice(delivered).some((c) => c.url.includes(sid))).toBe(false)
    } finally {
      restarted?.deps.relay.stop()
      await restarted?.close()
      s.deps.relay.stop()
      await s.close()
    }
  })

  it.each([404, 403])('retains deleted-session cleanup after HTTP %i until a replacement publisher accepts it', async (status) => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      const sid = String(((await json(await post(s, '/api/session/new', { title: 'Rejected cleanup' }))).session as Json).session_id)
      relay.viewedStatus = status
      expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
      await vi.waitFor(() => { expect(s.logs.some((l) => l.includes(status === 404 ? 'does not support viewed' : 'rejected a viewed'))).toBe(true) })
      const before = relay.views().length
      relay.viewedStatus = 200
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'again' }, 'default', true)
      await vi.waitFor(() => { expect(relay.views().slice(before).some((c) => c.url.includes(sid))).toBe(true) })
      await vi.waitFor(() => { expect(deletedViews(s)).toEqual([]) })
    } finally {
      s.deps.relay.stop()
      await s.close()
    }
  })

  it('persists bulk deletions without configuration, then delivers only the captured profile scope', async () => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    try {
      mkdirSync(s.deps.profileHome('work'), { recursive: true })
      const ids: string[] = []
      for (const profile of ['default', 'default', 'work']) {
        const sid = String(((await json(await post(s, '/api/session/new', { title: profile }))).session as Json).session_id)
        const session = (await s.deps.sessionStore.get(sid))
        session.profile = profile
        await s.deps.sessionStore.save(session)
        ids.push(sid)
      }
      const result = await json(await post(s, '/api/sessions/bulk', { action: 'delete', session_ids: ids.slice(0, 2) }))
      expect(result.results).toMatchObject(ids.slice(0, 2).map((session_id) => ({ session_id, ok: true })))
      expect(await s.deps.sessions.delete(ids[2]!)).toMatchObject({ ok: true })
      expect(relay.views()).toEqual([])
      expect(deletedViews(s).map((v) => v.profile)).toEqual(['default', 'default', 'work'])
      expect(statSync(join(s.state, 'talaria-relay-deleted.json')).mode & 0o777).toBe(0o600)
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      await vi.waitFor(() => { expect(deletedViews(s).map((v) => v.profile)).toEqual(['work']) })
      expect(relay.views().map((c) => c.url.split('/sessions/')[1]?.split('/')[0])).toEqual(ids.slice(0, 2))
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'work' }, 'work', true)
      await vi.waitFor(() => { expect(deletedViews(s)).toEqual([]) })
      const config = loadRelayConfig(s.state)!
      const call = relay.views().find((c) => c.url.includes(ids[2]!))!
      verifySigned(relay, call, `/v1/publishers/${encodeURIComponent('https://pub.example')}/profiles/${config.profiles.work!.profile_id}/sessions/${ids[2]!}/viewed`)
    } finally {
      s.deps.relay.stop()
      await s.close()
    }
  })

  it.each(['disabled', 'missing', 'identity', 'scope', 'publisher', 'origin'] as const)('keeps %s profile cleanup until its original configuration recovers', async (condition) => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      const config = loadRelayConfig(s.state)!
      s.deps.relay.stop()
      const sid = String(((await json(await post(s, '/api/session/new', { title: 'Paused cleanup' }))).session as Json).session_id)
      expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
      const pending = deletedViews(s)
      expect(pending).toHaveLength(1)
      if (condition === 'disabled') relay.snapshotStatus = 403
      if (condition === 'missing') saveRelayConfig(s.state, { ...config, profiles: { other: { identity: config.profiles.default!.identity, profile_id: 'prf_other' } } })
      if (condition === 'identity') writeFileSync(join(s.state, '.talaria-relay-profile-id'), 'pfi_11111111111111111111111111111111\n')
      if (condition === 'scope') saveRelayConfig(s.state, { ...config, profiles: { default: { ...config.profiles.default!, profile_id: 'prf_different' } } })
      if (condition === 'publisher') saveRelayConfig(s.state, { ...config, publisher_id: 'https://other-publisher.example' })
      if (condition === 'origin') saveRelayConfig(s.state, { ...config, url: 'https://other-relay.example' })
      expect(s.deps.relay.start()).toBe(true)
      const pass = vi.spyOn(s.deps.relay.current()!, 'publishStarted')
      await vi.waitFor(() => { expect(pass).toHaveBeenCalled() })
      expect(deletedViews(s)).toEqual(pending)
      expect(relay.views().some((c) => c.url.includes(sid))).toBe(false)
      pass.mockRestore()
      s.deps.relay.stop()
      relay.snapshotStatus = 200
      saveRelayConfig(s.state, config)
      writeFileSync(join(s.state, '.talaria-relay-profile-id'), config.profiles.default!.identity + '\n')
      expect(s.deps.relay.start()).toBe(true)
      await vi.waitFor(() => { expect(deletedViews(s)).toEqual([]) })
      expect(relay.views().filter((c) => c.url.includes(sid))).toHaveLength(1)
    } finally {
      s.deps.relay.stop()
      await s.close()
    }
  })

  it('refuses to overwrite corrupt durable cleanup when a deletion is attempted', async () => {
    const s = await bootTestServer()
    try {
      const path = join(s.state, 'talaria-relay-deleted.json')
      const corrupt = '{"version":1,"views":[{"sessionId":"pending"}]}'
      writeFileSync(path, corrupt)
      await expect(async () => { (await s.deps.relay.clearDeleted('another-deletion', 'default')) }).rejects.toThrow()
      expect(readFileSync(path, 'utf8')).toBe(corrupt)
      rmSync(path)
    } finally { await s.close() }
  })

  it('converges when a publisher is replaced while a deletion acknowledgement is in flight', async () => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    let release: () => void = () => undefined
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      s.deps.relay.stop()
      await s.deps.relay.clearDeleted('inflight-deletion', 'default')
      const cutoff = deletedViews(s)[0]!.through
      const stalled = new Promise<void>((resolve) => { release = resolve })
      s.deps.fetch = async (input, init) => {
        const response = await relay.fetch(input, init)
        if (relay.views().length === 1 && (typeof input === 'string' && input.endsWith('/inflight-deletion/viewed'))) await stalled
        return response
      }
      expect(s.deps.relay.start()).toBe(true)
      const previous = s.deps.relay.current()!
      const completedPass = vi.spyOn(previous, 'publishStarted')
      await vi.waitFor(() => { expect(relay.views()).toHaveLength(1) })
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'replace' }, 'default', true)
      expect(s.deps.relay.current()).not.toBe(previous)
      await vi.waitFor(() => { expect(deletedViews(s)).toEqual([]) })
      release()
      await vi.waitFor(() => { expect(completedPass).toHaveBeenCalled() })
      completedPass.mockRestore()
      expect(deletedViews(s)).toEqual([])
      expect(relay.views()).toHaveLength(2)
      expect(relay.views().map((c) => c.body.through)).toEqual([cutoff, cutoff])
    } finally {
      release()
      s.deps.relay.stop()
      await s.close()
    }
  })

  it('retries an accepted deletion after local persistence fails without losing a deletion queued in flight', async () => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    let release: () => void = () => undefined
    let failed = false
    const write = atomic.atomicWriteText
    const spy = vi.spyOn(atomic, 'atomicWriteText').mockImplementation((path, text, opts) => {
      if (!failed && path.endsWith('talaria-relay-deleted.json') && (JSON.parse(text) as { views: Json[] }).views.length === 1 && text.includes('second-deletion')) {
        failed = true
        throw new Error('synthetic acknowledgement persistence failure')
      }
      write(path, text, opts)
    })
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      s.deps.relay.stop()
      await s.deps.relay.clearDeleted('first-deletion', 'default')
      const first = deletedViews(s)[0]!
      const stalled = new Promise<void>((resolve) => { release = resolve })
      s.deps.fetch = async (input, init) => {
        const response = await relay.fetch(input, init)
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('/first-deletion/viewed') && relay.views().filter((c) => c.url.includes('first-deletion')).length === 1) await stalled
        return response
      }
      expect(s.deps.relay.start()).toBe(true)
      await vi.waitFor(() => { expect(relay.views()).toHaveLength(1) })
      await s.deps.relay.clearDeleted('second-deletion', 'default')
      expect(deletedViews(s)).toHaveLength(2)
      release()
      await vi.waitFor(() => { expect(failed).toBe(true) })
      expect(deletedViews(s)).toHaveLength(2)
      s.deps.relay.stop()
      expect(s.deps.relay.start()).toBe(true)
      await vi.waitFor(() => { expect(deletedViews(s)).toEqual([]) })
      const firstCalls = relay.views().filter((c) => c.url.includes('first-deletion'))
      expect(firstCalls.length).toBeGreaterThanOrEqual(2)
      expect(firstCalls.every((c) => c.body.through === first.through)).toBe(true)
      expect(new Set(firstCalls.map((c) => c.headers['x-talaria-nonce'])).size).toBe(firstCalls.length)
      expect(relay.views().some((c) => c.url.includes('second-deletion'))).toBe(true)
    } finally {
      release()
      spy.mockRestore()
      s.deps.relay.stop()
      await s.close()
    }
  })

  it('isolates a permanent failure to one profile and raises retryable ones', async () => {
    const s = await bootTestServer()
    const relay = fakeRelay()
    s.deps.fetch = relay.fetch
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      const base = loadRelayConfig(s.state)!
      const config: RelayConfig = { ...base, profiles: { ...base.profiles, other: { identity: '', profile_id: 'prf_other' } } }
      const publisher = new RelayPublisher(config, { stateDir: s.state, registry: s.deps.registry, pending: s.deps.pending, store: s.deps.sessionStore, presence: s.deps.relay.presence, profileHome: s.deps.profileHome, profilesMatch: s.deps.profilesMatch, agentSessions: () => Promise.resolve([]), fetch: () => s.deps.fetch, now: () => Date.now() / 1000, log: (l) => s.logs.push(l) })
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
      const publisher = new RelayPublisher(loadRelayConfig(s.state)!, { stateDir: s.state, registry: s.deps.registry, pending: s.deps.pending, store: s.deps.sessionStore, presence: s.deps.relay.presence, profileHome: s.deps.profileHome, profilesMatch: s.deps.profilesMatch, agentSessions: () => Promise.resolve([]), fetch: () => s.deps.fetch, now: () => clock, log: (l) => s.logs.push(l) })
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

describe('session-started events from the running server', () => {
  it('announces a new chat and a new Agent session once each, and a stalled relay never blocks chat or the list', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    const relay = fakeRelay()
    const attempts: string[] = []
    let release: () => void = () => undefined
    const stalled = new Promise<void>((resolve) => { release = resolve })
    s.deps.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.endsWith('/started')) return relay.fetch(input, init)
      attempts.push(url)
      return stalled.then(() => relay.fetch(input, init))
    }
    const reply = (params: Record<string, unknown>): SidecarResult<'chat.start'> => ({
      status: 'completed', messages: [{ role: 'user', content: String(params.user_message) }, { role: 'assistant', content: 'Hi' }], final_response: 'Hi', error: null, failed: false, partial: false,
      compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: null, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
      agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
    } as unknown as SidecarResult<'chat.start'>)
    sidecar.respond('chat.start', reply)
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Hello"', usage: null }))
    const chat = async (message: string): Promise<string> => {
      const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
      expect((await post(s, '/api/chat/start', { session_id: sid, message })).status).toBe(200)
      await vi.waitFor(async () => { expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages).toHaveLength(2) })
      return sid
    }
    try {
      await s.deps.relay.pair({ relay_url: RELAY, publisher_id: 'https://pub.example', publisher_invitation: 'x' }, 'default', true)
      const profileId = loadRelayConfig(s.state)!.profiles.default!.profile_id
      const startedPath = (sid: string): string => `/v1/publishers/${encodeURIComponent('https://pub.example')}/profiles/${profileId}/sessions/${sid}/started`
      // A publisher pass ends before the next one's snapshot, so two snapshots mean tracking began before these sessions.
      const passes = async (): Promise<void> => {
        for (let i = 0; i < 2; i++) {
          const before = relay.snapshots().length
          s.deps.relay.current()!.changed()
          await vi.waitFor(() => { expect(relay.snapshots().length).toBeGreaterThan(before) })
        }
      }
      await passes()

      const first = await chat('hello there')
      await vi.waitFor(() => { expect(attempts).toEqual([RELAY + startedPath(first)]) })
      // The relay has not answered: another chat still starts and the list still reads.
      const second = await chat('and again')
      expect(((await json(await s.get('/api/sessions'))).sessions as Json[]).map((row) => row.session_id)).toEqual(expect.arrayContaining([first, second]))

      const db = new DatabaseSync(join(s.state, 'state.db'))
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL, message_count INTEGER DEFAULT 0, title TEXT, parent_session_id TEXT, ended_at REAL, end_reason TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL)`)
      const startedAt = Date.now() / 1000
      db.prepare('INSERT INTO sessions (id, source, started_at, message_count, title) VALUES (?, ?, ?, ?, ?)').run('cli_session_0001', 'cli', startedAt, 1, 'From the terminal')
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('cli_session_0001', 'user', 'hi', startedAt)
      db.close()

      release()
      const started = (): Captured[] => relay.calls.filter((c) => c.url.endsWith('/started'))
      await vi.waitFor(() => {
        s.deps.relay.current()!.changed()
        expect(started().map((c) => c.body.sessionId)).toEqual(expect.arrayContaining([first, second, 'cli_session_0001']))
      })
      const firstCall = started().find((c) => c.body.sessionId === first)!
      verifySigned(relay, firstCall, startedPath(first))
      expect(firstCall.body).toEqual({ version: 1, eventId: `started:${first}`, publisherId: 'https://pub.example', profileId, sessionId: first, startedAt: firstCall.body.startedAt })

      // Another turn and further publisher passes announce nothing more.
      expect((await post(s, '/api/chat/start', { session_id: first, message: 'one more' })).status).toBe(200)
      await vi.waitFor(async () => { expect(((await json(await s.get(`/api/session?session_id=${first}`))).session as Json).messages).toHaveLength(4) })
      await passes()
      expect(started().map((c) => c.body.sessionId).sort()).toEqual([first, second, 'cli_session_0001'].sort())
    } finally {
      release()
      s.deps.relay.stop()
      await s.close()
    }
  })
})
