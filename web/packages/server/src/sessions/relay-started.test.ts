import { JsonDocuments } from '../test/storage.js'
import { testProfileIdentity } from '../test/storage.js'
import { initializeStore } from '../test/storage.js'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PresenceLeases, RelayPublisher, type RelayConfig, type RelayPublisherDeps } from './relay.js'
import { StreamRegistry } from './streams.js'

type Row = Record<string, unknown>
interface Sent { url: string; body: Row }

let home: string
let clock: number
let index: Row[]
let agent: Record<string, Row[]>
let sent: Sent[]
let respond: (url: string) => Promise<Response>
let config: RelayConfig
let reads: { agent: number; index: number }

const PUB = 'https://pub.example'
const startedPath = (profileId: string, sid: string): string => `https://relay.example/v1/publishers/${encodeURIComponent(PUB)}/profiles/${profileId}/sessions/${sid}/started`
const started = (): Sent[] => sent.filter((s) => s.url.endsWith('/started'))

async function publisher(extra: Partial<RelayPublisherDeps> = {}): Promise<RelayPublisher> {
  const deps = {
    documents: new JsonDocuments(home, (profile) => join(home, profile)),
    registry: new StreamRegistry(), presence: new PresenceLeases(() => clock), now: () => clock, log: vi.fn(),
    pending: { approvalPending: () => ({ pending: null, pending_count: 0 }), clarifyPending: () => ({ pending: null, pending_count: 0 }) },
    store: { get: () => { throw new Error('unused') }, readIndexEntries: () => { reads.index += 1; return index } },
    agentSessions: (profile: string) => { reads.agent += 1; return Promise.resolve(agent[profile] ?? []) },
    profileHome: (profile: string) => join(home, profile),
    profilesMatch: (row: string | null | undefined, active: string | null | undefined) => (row ?? 'default') === active,
    fetch: () => (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) as Row }); return respond(url) },
    ...extra,
  } as unknown as RelayPublisherDeps
  return (await initializeStore(new RelayPublisher(config, deps)))
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'talaria-relay-started-'))
  clock = 1_800_000_000
  index = []
  agent = {}
  sent = []
  reads = { agent: 0, index: 0 }
  respond = () => Promise.resolve(new Response('{}'))
  const keyPath = join(home, 'publisher.pem')
  writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  for (const profile of ['default', 'work']) mkdirSync(join(home, profile))
  config = {
    url: 'https://relay.example', publisher_id: PUB, key_id: 'key-1', private_key_path: keyPath,
    profiles: { default: { identity: (await testProfileIdentity(join(home, 'default'))), profile_id: 'prf_default' }, work: { identity: (await testProfileIdentity(join(home, 'work'))), profile_id: 'prf_work' } },
  }
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

it('announces each new Web and Agent-discovered session once, never the sessions that existed before', async () => {
  index = [{ session_id: 'web-old', created_at: clock - 5, message_count: 3, profile: null }]
  agent = { default: [{ id: 'cli-old', started_at: clock - 5 }] }
  const p = (await publisher())
  await p.publishStarted()
  expect(started()).toEqual([])

  clock += 10
  index.push({ session_id: 'web-new', created_at: clock - 2, message_count: 1, profile: null }, { session_id: 'web-hidden', created_at: clock - 1, message_count: 0, profile: null })
  agent.default!.push({ id: 'cli-new', started_at: clock - 1 })
  await p.publishStarted()
  expect(started()).toEqual([
    { url: startedPath('prf_default', 'web-new'), body: { version: 1, eventId: 'started:web-new', publisherId: PUB, profileId: 'prf_default', sessionId: 'web-new', startedAt: (clock - 2) * 1000 } },
    { url: startedPath('prf_default', 'cli-new'), body: { version: 1, eventId: 'started:cli-new', publisherId: PUB, profileId: 'prf_default', sessionId: 'cli-new', startedAt: (clock - 1) * 1000 } },
  ])

  // Later turns, a compressed Agent chat's new segment, list polls, and a restarted server observe the same sessions
  // again without re-announcing them.
  index[1]!.message_count = 9
  agent.default![1] = { id: 'cli-new-segment-2', _lineage_root_id: 'cli-new', started_at: clock - 1 }
  await p.publishStarted()
  await (await publisher()).publishStarted()
  expect(started()).toHaveLength(2)
})

it('sends each session only to the relay scope of the profile that owns it', async () => {
  await (await publisher()).publishStarted()
  clock += 10
  index = [{ session_id: 'web-a', created_at: clock, message_count: 1, profile: 'default' }, { session_id: 'web-b', created_at: clock, message_count: 1, profile: 'work' }]
  agent = { work: [{ id: 'cli-b', started_at: clock }] }
  await (await publisher()).publishStarted()
  expect(started().map((s) => [s.url, s.body.profileId])).toEqual([
    [startedPath('prf_default', 'web-a'), 'prf_default'],
    [startedPath('prf_work', 'web-b'), 'prf_work'],
    [startedPath('prf_work', 'cli-b'), 'prf_work'],
  ])
})

it('retries a failed or interrupted event under the same event ID after a restart', async () => {
  await (await publisher()).publishStarted()
  clock += 10
  index = [{ session_id: 'web-new', created_at: clock, message_count: 1, profile: null }]
  respond = () => Promise.resolve(new Response('busy', { status: 503 }))
  await expect((await publisher()).publishStarted()).rejects.toThrow('HTTP 503')
  respond = () => Promise.reject(new Error('socket hang up'))
  await expect((await publisher()).publishStarted()).rejects.toThrow('Could not reach Talaria Relay')
  respond = () => Promise.resolve(new Response('{}'))
  const restarted = (await publisher())
  await restarted.publishStarted()
  await restarted.publishStarted()
  expect(started().map((s) => s.body.eventId)).toEqual(['started:web-new', 'started:web-new', 'started:web-new'])
})

it('drops an event the relay permanently rejects instead of retrying it forever', async () => {
  await (await publisher()).publishStarted()
  clock += 10
  index = [{ session_id: 'web-new', created_at: clock, message_count: 1, profile: null }]
  respond = () => Promise.resolve(new Response('not found', { status: 404 }))
  const p = (await publisher())
  await p.publishStarted()
  await p.publishStarted()
  expect(started()).toHaveLength(1)
})

it('keeps observing new sessions while the relay is slow', async () => {
  const p = (await publisher())
  await p.publishStarted()
  clock += 10
  let release: () => void = () => undefined
  respond = (url) => (url.endsWith('/started') ? new Promise((resolve) => { release = () => { resolve(new Response('{}')) } }) : Promise.resolve(new Response('{}')))
  index = [{ session_id: 'web-1', created_at: clock, message_count: 1, profile: null }]
  const slow = p.publishStarted()
  await vi.waitFor(() => { expect(started()).toHaveLength(1) })
  // The stalled request holds only the publisher: new sessions are still recorded and go out once it settles.
  index.push({ session_id: 'web-2', created_at: clock, message_count: 1, profile: null })
  respond = () => Promise.resolve(new Response('{}'))
  release()
  await slow
  await p.publishStarted()
  expect(started().map((s) => s.body.sessionId)).toEqual(['web-1', 'web-2'])
})

it('announces the chat whose change wakes the first pass after an upgrade', async () => {
  // Tracking starts when the publisher starts, not when its first pass runs after that chat began.
  const p = (await publisher())
  clock += 1
  index = [{ session_id: 'web-first', created_at: clock, message_count: 1, profile: null }]
  clock += 1
  await p.publishStarted()
  expect(started().map((s) => s.body.sessionId)).toEqual(['web-first'])
})

describe('idle passes (TAL-1722)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  afterEach(() => { vi.useRealTimers() })
  /** The loop is asleep until its next 60 s tick. */
  const asleep = (): Promise<void> => vi.waitFor(() => { expect(vi.getTimerCount()).toBe(1) })
  const tick = async (): Promise<void> => { clock += 60; await vi.advanceTimersByTimeAsync(60_000); await asleep() }

  it('reads and sends nothing on idle ticks while no event arrived and state.db is unchanged, and observes a state.db write', async () => {
    let stamp = 'state-db-1'
    const p = await publisher({ agentSessionsStamp: () => stamp })
    await p.start()
    await vi.waitFor(() => { expect(reads.agent).toBeGreaterThan(0) })
    await asleep()
    const before = { ...reads, sent: sent.length }
    for (let i = 0; i < 10; i++) await tick()
    expect({ ...reads, sent: sent.length }).toEqual(before)

    // A session an Agent CLI started moves state.db without any Web event; the next tick announces it.
    agent = { default: [{ id: 'cli-new', started_at: clock }] }
    stamp = 'state-db-2'
    await tick()
    expect(started().map((s) => s.body.sessionId)).toEqual(['cli-new'])
    p.stop()
  })

  it('keeps refreshing the lease of live activity on idle ticks without rereading the session lists', async () => {
    const live = { session_id: 'live', profile: null, title: 'Live', owner_person_id: null }
    const registry = new StreamRegistry()
    registry.activeRuns.set('stream-live', { stream_id: 'stream-live', session_id: 'live', started_at: clock, phase: 'running', workspace: home, model: null, provider: null, ephemeral: false })
    const p = await publisher({ registry, agentSessionsStamp: () => 'state-db-1', store: { get: () => Promise.resolve(live), readIndexEntries: () => { reads.index += 1; return index } } as unknown as RelayPublisherDeps['store'] })
    await p.start()
    await vi.waitFor(() => { expect(reads.agent).toBeGreaterThan(0) })
    await asleep()
    const snapshots = (): Sent[] => sent.filter((s) => s.url.endsWith('/prf_default/snapshot'))
    const before = { ...reads, snapshots: snapshots().length }
    for (let i = 0; i < 3; i++) await tick()
    expect(reads).toEqual({ agent: before.agent, index: before.index })
    expect(snapshots().slice(before.snapshots).map((s) => (s.body.states as Row[]).map((state) => state.phase))).toEqual([['running'], ['running'], ['running']])
    p.stop()
  })
})
