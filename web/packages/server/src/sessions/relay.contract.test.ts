import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PresenceLeases, profileIdentity, RelayPublisher, type RelayPublisherDeps } from './relay.js'
import { StreamRegistry } from './streams.js'

vi.mock(import('node:crypto'), async (original) => ({ ...(await original()), randomUUID: () => '00000000-0000-0000-0000-000000000001' }))

// The Relay gate accepts this fixture as the Web publisher's body (relay/tests/sharedContracts.test.ts), so the real publisher must produce it.
it('publishes exactly the shared publisher-snapshot fixture', async () => {
  const expected = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/publisher-snapshot.json'), 'utf8')) as { states: { updatedAt: number }[] }
  const now = expected.states[0]!.updatedAt / 1000
  const home = mkdtempSync(join(tmpdir(), 'talaria-relay-contract-'))
  try {
    const keyPath = join(home, 'publisher.pem')
    writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const registry = new StreamRegistry()
    registry.activeRuns.set('contract-stream', { stream_id: 'contract-stream', session_id: 'contract-session', started_at: 1, phase: 'running', workspace: home, model: null, provider: null, ephemeral: false })
    const presence = new PresenceLeases(() => now)
    presence.renew('default', 'tab_contract')
    const requests: { url: string; body: string }[] = []
    const deps = {
      registry, presence, now: () => now, log: vi.fn(),
      pending: { approvalPending: () => ({ pending: null, pending_count: 0 }), clarifyPending: () => ({ pending: null, pending_count: 0 }) },
      store: { get: () => ({ title: 'Contract fixture', profile: 'default' }) },
      profileHome: () => home,
      profilesMatch: (row: string | null | undefined, active: string | null | undefined) => row === active,
      fetch: () => (url: string, init: { body: string }) => { requests.push({ url, body: init.body }); return Promise.resolve(new Response('{}')) },
    } as unknown as RelayPublisherDeps
    const publisher = new RelayPublisher({ url: 'https://relay.example', publisher_id: 'https://contract.example', key_id: 'contract-key', private_key_path: keyPath, profiles: { default: { identity: profileIdentity(home), profile_id: 'prf_default' } } }, deps)
    await publisher.publishSnapshot()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(`https://relay.example/v1/publishers/${encodeURIComponent('https://contract.example')}/profiles/prf_default/snapshot`)
    expect(JSON.parse(requests[0]!.body)).toEqual(expected)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The Relay gate accepts this fixture as the Web publisher's session-started body (relay/tests/sharedContracts.test.ts).
it('publishes exactly the shared publisher-session-started fixture', async () => {
  const expected = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/publisher-session-started.json'), 'utf8')) as { startedAt: number }
  let now = expected.startedAt / 1000 - 10
  const home = mkdtempSync(join(tmpdir(), 'talaria-relay-contract-'))
  try {
    const keyPath = join(home, 'publisher.pem')
    writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const index: Record<string, unknown>[] = []
    const requests: { url: string; body: string }[] = []
    const deps = {
      registry: new StreamRegistry(), presence: new PresenceLeases(() => now), now: () => now, log: vi.fn(),
      store: { readIndexEntries: () => index },
      agentSessions: () => [],
      profileHome: () => home,
      profilesMatch: (row: string | null | undefined, active: string | null | undefined) => (row ?? 'default') === active,
      fetch: () => (url: string, init: { body: string }) => { requests.push({ url, body: init.body }); return Promise.resolve(new Response('{}')) },
    } as unknown as RelayPublisherDeps
    const publisher = new RelayPublisher({ url: 'https://relay.example', publisher_id: 'https://contract.example', key_id: 'contract-key', private_key_path: keyPath, profiles: { default: { identity: profileIdentity(home), profile_id: 'prf_default' } } }, deps)
    await publisher.publishStarted()
    now += 10
    index.push({ session_id: 'contract-session', created_at: expected.startedAt / 1000, message_count: 1, profile: null })
    await publisher.publishStarted()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(`https://relay.example/v1/publishers/${encodeURIComponent('https://contract.example')}/profiles/prf_default/sessions/contract-session/started`)
    expect(JSON.parse(requests[0]!.body)).toEqual(expected)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
