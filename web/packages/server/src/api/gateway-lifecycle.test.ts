/**
 * TAL-1627: every Gateway lifecycle entry point reads one server-owned capability. A Gateway Web only monitors is refused
 * with a typed 409 before any sidecar lock or CLI runs; status and health carry the same capability for Settings.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

type Json = Record<string, unknown>
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const post = (s: TestServer, path: string, body: unknown = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const LIFECYCLE_CALLS = new Set(['gateway.control', 'gateway.restart'])
const EXTERNAL = { managed: false, reason: 'external_gateway', start_command: null }
const MANAGED = { managed: true, reason: 'local_gateway', start_command: null }

const servers: TestServer[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A server whose explicit Gateway URL is `url`; `answering` is what the monitored endpoint's health probe sees. */
async function boot(url: string, opts: { home?: string; answering?: () => boolean } = {}) {
  const sidecar = new FakeSidecar()
  const completed = { status: 'completed' as const, message: 'Gateway service done' }
  sidecar.respond('gateway.control', () => completed)
  sidecar.respond('gateway.restart', () => completed)
  const answering = opts.answering ?? (() => true)
  const fetchStub: typeof fetch = () => answering() ? Promise.resolve(new Response(JSON.stringify({ gateway_state: 'running' }), { status: 200 })) : Promise.reject(new TypeError('connect ECONNREFUSED'))
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'talaria-gateway-lifecycle-'))
  if (!opts.home) dirs.push(home)
  const s = await bootTestServer({ sidecar, env: { HERMES_API_URL: url, HERMES_HOME: home, HERMES_WEBUI_STATE_DIR: home }, deps: (deps) => { deps.fetch = fetchStub } })
  servers.push(s)
  const dispatched = () => sidecar.calls.filter((call) => LIFECYCLE_CALLS.has(call.method)).map((call) => call.method)
  return { s, sidecar, home, dispatched }
}

describe('Gateway lifecycle routes (TAL-1627)', () => {
  it('refuses every lifecycle entry point for an explicit remote Gateway before dispatching anything', async () => {
    const { s, sidecar, dispatched } = await boot('https://gateway.example')
    for (const action of ['start', 'stop', 'restart'] as const) {
      const res = await post(s, `/api/gateway/${action}`)
      expect([res.status, await json(res)]).toEqual([409, { error: 'This Gateway is managed outside Talaria. Start, stop, or restart it where it runs.', ok: false, code: 'gateway_externally_managed', action, lifecycle: EXTERNAL }])
    }
    const restart = await post(s, '/api/health/restart')
    expect([restart.status, await json(restart)]).toMatchObject([409, { ok: false, code: 'gateway_externally_managed', action: 'restart', lifecycle: EXTERNAL }])
    expect(dispatched()).toEqual([])
    // A non-loopback URL is decided from the URL alone: no ownership probe runs.
    expect(sidecar.calls.some((call) => call.method === 'gateway.ownership')).toBe(false)
    expect(await json(await s.get('/api/gateway/status'))).toMatchObject({ running: true, gateway_mode: null, health: { reason: 'remote_gateway' }, lifecycle: EXTERNAL })
    expect(await json(await s.get('/api/health/agent'))).toMatchObject({ alive: true, gateway_lifecycle: EXTERNAL })
  })

  it('keeps the local profile lifecycle when no Gateway URL is set', async () => {
    const sidecar = new FakeSidecar()
    sidecar.respond('gateway.control', () => ({ status: 'completed', message: 'ok' }))
    const s = await bootTestServer({ sidecar })
    servers.push(s)
    expect(await json(await s.get('/api/gateway/status'))).toMatchObject({ lifecycle: MANAGED })
    expect((await post(s, '/api/gateway/stop')).status).toBe(200)
    expect(sidecar.calls.filter((call) => call.method === 'gateway.control')).toHaveLength(1)
    expect(sidecar.calls.some((call) => call.method === 'gateway.ownership')).toBe(false)
  })

  it('a proven loopback Gateway stays controllable after Stop and a server restart; a changed endpoint must be proven again', async () => {
    const down = { now: false }
    const first = await boot('http://127.0.0.1:8642', { answering: () => !down.now })
    let state: 'owned' | 'stopped' = 'owned'
    first.sidecar.respond('gateway.ownership', (params) => { expect(params.port).toBe(8642); return { state, start_command: 'hermes --profile default gateway start' } })
    expect(await json(await first.s.get('/api/gateway/status'))).toMatchObject({ lifecycle: MANAGED })
    // Stop takes the gateway down while it runs; the status it returns reads the endpoint afresh, not the cached probe.
    first.sidecar.respond('gateway.control', () => { state = 'stopped'; down.now = true; return { status: 'completed', message: 'Gateway service stopped' } })
    const stop = await post(first.s, '/api/gateway/stop')
    expect([stop.status, await json(stop)]).toMatchObject([200, { ok: true, status: { running: false, lifecycle: MANAGED } }])
    expect(await json(await first.s.get('/api/gateway/status'))).toMatchObject({ lifecycle: MANAGED })
    expect((await post(first.s, '/api/gateway/start')).status).toBe(200)
    expect(first.dispatched()).toEqual(['gateway.control', 'gateway.control'])
    // The custody record holds the credential-free endpoint only.
    expect(readFileSync(join(first.home, 'gateway-lifecycle-custody.json'), 'utf8')).toContain('"endpoint": "http://127.0.0.1:8642"')
    await first.s.close()
    servers.splice(0)

    const again = await boot('http://127.0.0.1:8642', { home: first.home, answering: () => false })
    again.sidecar.respond('gateway.ownership', () => ({ state: 'stopped', start_command: 'hermes --profile default gateway start' }))
    expect(await json(await again.s.get('/api/gateway/status'))).toMatchObject({ lifecycle: MANAGED })
    expect((await post(again.s, '/api/health/restart')).status).toBe(200)
    await again.s.close()
    servers.splice(0)

    const moved = await boot('http://user:hunter2@localhost:9000/', { home: first.home, answering: () => false })
    moved.sidecar.respond('gateway.ownership', () => ({ state: 'stopped', start_command: 'hermes --profile default gateway start' }))
    const unproven = { managed: false, reason: 'local_gateway_unproven', start_command: 'hermes --profile default gateway start' }
    const status = await moved.s.get('/api/gateway/status')
    const text = await status.text()
    expect(text).not.toContain('hunter2')
    expect(JSON.parse(text)).toMatchObject({ lifecycle: unproven })
    const start = await post(moved.s, '/api/gateway/start')
    expect([start.status, await json(start)]).toMatchObject([409, { code: 'gateway_externally_managed', lifecycle: unproven }])
    expect(moved.dispatched()).toEqual([])
    expect(readFileSync(join(first.home, 'gateway-lifecycle-custody.json'), 'utf8')).not.toContain('8642')
  })

  it('an Agent update with an uncontrolled Gateway never restarts it or reports it restarted', async () => {
    const { s, sidecar, dispatched } = await boot('https://gateway.example')
    sidecar.respond('runtime.status', () => ({ ...sidecar.describe!, compatible: true, stale: false }))
    const row = async (id: unknown) => ((await json(await s.get('/api/update-notifications'))).notifications as Json[]).find((entry) => entry.id === id)
    const until = async (id: unknown, phase: string) => { for (let i = 0; i < 250 && (await row(id))?.phase !== phase; i += 1) await new Promise((resolve) => setTimeout(resolve, 20)) }
    // The Web-driven restart after a dependency sync.
    s.deps.updates.apply = () => Promise.resolve({ ok: true, target: 'agent', verified_revision: 'e'.repeat(40), verified_version: 'v0.23.0', restart_scheduled: false, gateway_restart: 'waiting_for_idle' })
    const waited = await json(await post(s, '/api/updates/apply', { target: 'agent', tab_id: 'tab-external-wait' }))
    await until(waited.notification_id, 'failed')
    expect(await row(waited.notification_id)).toMatchObject({ phase: 'failed', detail: expect.stringContaining('was not restarted') as string })
    expect(dispatched()).toEqual([])
    // The native updater restarted only the local gateways it paused: the update succeeds and names the monitored Gateway as not restarted.
    s.deps.updates.apply = () => Promise.resolve({ ok: true, target: 'agent', verified_revision: 'e'.repeat(40), verified_version: 'v0.23.0', restart_scheduled: false, gateway_restart: 'resumed' })
    const resumed = await json(await post(s, '/api/updates/apply', { target: 'agent', tab_id: 'tab-external-native' }))
    await until(resumed.notification_id, 'succeeded')
    expect(await row(resumed.notification_id)).toMatchObject({ phase: 'succeeded', detail: expect.stringContaining('was not restarted') as string })
    expect(dispatched()).toEqual([])
  })
})
