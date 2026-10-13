/** TAL-953: the post-update gateway restart waits for a synthetic gateway's `active_agents` to drain. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Dict } from '../config/agent-config.js'
import { GatewayRestartQueue } from './gateway-restart.js'
import { gatewayRestartBlockers } from './health.js'
import { GATEWAY_RESTART_NOW, UpdateNotificationStore, type UpdateNotificationScope } from './update-notifications.js'
import { bootTestServer } from '../test/harness.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const OWNER: UpdateNotificationScope = { owner: 'local-owner', profile: 'default', serverOwner: true }
const NOW = Date.parse('2026-10-13T12:00:00Z') / 1000
const stamp = (offsetS = 0): string => new Date((NOW + offsetS) * 1000).toISOString()
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve) }) }

/** A Hermes home with a synthetic gateway, a notification store, and a queue whose polls advance only on `tick()`. */
function setup(stateDir = mkdtempSync(join(tmpdir(), 'talaria-gateway-restart-')), restart: () => Promise<Dict> = () => Promise.resolve({ status: 'completed' }), updating = { now: false }, probe: () => void = () => undefined) {
  dirs.push(stateDir)
  const home = join(stateDir, 'home')
  const gateway = (state: { pid?: number | null; gateway_state?: string; active_agents?: number; updated_at?: string } = {}): void => {
    rmSync(home, { recursive: true, force: true })
    mkdirSync(home, { recursive: true })
    if (state.pid !== null) writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: state.pid ?? process.pid }))
    writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ gateway_state: state.gateway_state ?? 'running', active_agents: state.active_agents ?? 0, updated_at: state.updated_at ?? stamp() }))
  }
  const store = new UpdateNotificationStore(stateDir)
  const calls: string[] = []
  const profiles: string[] = []
  const waiters: (() => void)[] = []
  const queue = new GatewayRestartQueue({
    notifications: store,
    blockers: (profile) => { profiles.push(`probe:${profile}`); const blockers = gatewayRestartBlockers(home, home, NOW); probe(); return blockers },
    restart: (profile) => { calls.push('gateway.restart'); profiles.push(`restart:${profile}`); return restart() },
    updating: () => updating.now,
    sleep: () => new Promise<void>((resolve) => { waiters.push(resolve) }),
    log: () => undefined,
  })
  const tick = async (): Promise<void> => { await flush(); for (const wake of waiters.splice(0)) wake(); await flush() }
  /** What `applyWithNotification` records for a finished Agent update before handing it to the queue. */
  const waiting = (detail: string | null = null, profile = 'default'): string => {
    const row = store.begin({ ...OWNER, profile }, 'agent')
    store.transition(row.id, 'waiting_for_idle', null, undefined, detail)
    return row.id
  }
  const row = (id: string) => store.list(OWNER).notifications.find((entry) => entry.id === id)
  return { stateDir, home, gateway, store, queue, calls, profiles, tick, waiting, row }
}

describe('gatewayRestartBlockers', () => {
  it('blocks only a live gateway with running work', async () => {
    const t = setup()
    t.gateway({ active_agents: 2 })
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ active_runs: 2, restart_blocked: true })
    t.gateway({ active_agents: 0 })
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ active_runs: 0, restart_blocked: false })
    // Stopped, stale, and missing gateways have nothing to drain, whatever their last count said.
    t.gateway({ pid: null, gateway_state: 'stopped', active_agents: 2 })
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ restart_blocked: false })
    t.gateway({ pid: null, active_agents: 2, updated_at: stamp(-600) })
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ restart_blocked: false })
    rmSync(t.home, { recursive: true, force: true })
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ restart_blocked: false })
  })

  it('keeps a live gateway whose running work cannot be read blocked', async () => {
    const t = setup()
    t.gateway({ active_agents: 0 })
    writeFileSync(join(t.home, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running', updated_at: stamp() }))
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ active_runs: 0, restart_blocked: true })
    writeFileSync(join(t.home, 'gateway_state.json'), '{not json')
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ restart_blocked: true })
    rmSync(join(t.home, 'gateway_state.json'))
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ restart_blocked: true })
  })

  it('counts both the root host gateway and the named profile\'s own gateway', async () => {
    const t = setup()
    const profile = join(t.stateDir, 'profiles', 'work')
    mkdirSync(profile, { recursive: true })
    const own = (agents: number): void => {
      writeFileSync(join(profile, 'gateway.pid'), JSON.stringify({ pid: process.pid }))
      writeFileSync(join(profile, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running', active_agents: agents, updated_at: stamp() }))
    }
    t.gateway({ active_agents: 0 })
    own(2)
    expect(await gatewayRestartBlockers(t.home, profile, NOW)).toMatchObject({ active_runs: 2, restart_blocked: true })
    t.gateway({ active_agents: 1 })
    own(0)
    expect(await gatewayRestartBlockers(t.home, profile, NOW)).toMatchObject({ active_runs: 1, restart_blocked: true })
    t.gateway({ active_agents: 0 })
    expect(await gatewayRestartBlockers(t.home, profile, NOW)).toMatchObject({ active_runs: 0, restart_blocked: false })
  })
})

describe('GatewayRestartQueue', () => {
  it('holds the restart while the gateway is busy and restarts exactly once when it goes idle', async () => {
    const t = setup()
    t.gateway({ active_agents: 2 })
    const id = t.waiting()
    expect(t.queue.schedule(id, 'default')).toBe(id)
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual([])
    expect(t.row(id)).toMatchObject({
      phase: 'waiting_for_idle', can_dismiss: false,
      message: 'Waiting for 2 running gateway tasks to finish before restarting the gateway.',
      actions: [{ id: GATEWAY_RESTART_NOW, label: 'Restart now', style: 'destructive', acknowledges: false }],
    })
    t.gateway({ active_agents: 1 })
    await t.tick()
    expect(t.row(id)?.message).toBe('Waiting for 1 running gateway task to finish before restarting the gateway.')
    t.gateway({ active_agents: 0 })
    await t.tick()
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect(t.row(id)).toMatchObject({ phase: 'succeeded', actions: [], can_dismiss: true })
  })

  it.each([
    ['stopped', { pid: null, gateway_state: 'stopped', active_agents: 2 }],
    ['stale', { pid: null, active_agents: 2, updated_at: stamp(-600) }],
  ] as const)('restarts a %s gateway immediately', async (_name, state) => {
    const t = setup()
    t.gateway(state)
    const id = t.waiting()
    t.queue.schedule(id, 'default')
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect(t.row(id)?.phase).toBe('succeeded')
  })

  it('Restart now restarts at once while the gateway is still busy and ends the wait', async () => {
    const t = setup()
    t.gateway({ active_agents: 3 })
    const id = t.waiting()
    t.queue.schedule(id, 'default')
    await t.tick()
    expect(t.calls).toEqual([])
    expect(t.queue.restartNow('another-id')).toBe(false)
    expect(t.queue.restartNow(id)).toBe(true)
    await flush()
    expect(t.calls).toEqual(['gateway.restart'])
    expect(t.row(id)?.phase).toBe('succeeded')
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect(t.queue.restartNow(id)).toBe(false)
  })

  it('starts no restart, even a forced one, while another update changes the Agent source', async () => {
    const updating = { now: true }
    const t = setup(undefined, undefined, updating)
    t.gateway({ active_agents: 0 })
    const id = t.waiting()
    t.queue.schedule(id, 'default')
    await t.tick()
    t.queue.restartNow(id)
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual([])
    expect(t.row(id)?.phase).toBe('waiting_for_idle')
    updating.now = false
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect(t.row(id)?.phase).toBe('succeeded')
  })

  it('rechecks the update lock after the blocker probe, so an update that starts mid-probe holds the restart', async () => {
    const updating = { now: false }
    let probes = 0
    const t = setup(undefined, undefined, updating, () => { probes += 1; if (probes === 1) updating.now = true })
    t.gateway({ active_agents: 0 })
    const id = t.waiting()
    t.queue.schedule(id, 'default')
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual([])
    expect(t.row(id)?.phase).toBe('waiting_for_idle')
    updating.now = false
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
  })

  it('a second update while one waits reuses the waiting record instead of starting a second wait', async () => {
    const t = setup()
    t.gateway({ active_agents: 1 })
    const first = t.waiting()
    t.queue.schedule(first, 'default')
    const second = t.waiting('stash kept')
    expect(t.queue.schedule(second, 'default', 'stash kept')).toBe(first)
    expect(t.row(second)).toMatchObject({ phase: 'succeeded', actions: [], detail: expect.stringContaining('stash kept') as string })
    t.gateway({ active_agents: 0 })
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect(t.row(first)?.phase).toBe('succeeded')
  })

  it('a waiting record survives a server restart, and the restarted server resumes it', async () => {
    const before = setup()
    before.gateway({ active_agents: 2 })
    const id = before.waiting('stash kept', 'work')
    before.queue.schedule(id, 'work')
    await before.tick()
    await before.queue.quiesce()
    expect(before.calls).toEqual([])
    const after = setup(before.stateDir)
    after.gateway({ active_agents: 2 })
    expect(after.row(id)).toMatchObject({ phase: 'waiting_for_idle', actions: [{ id: GATEWAY_RESTART_NOW }] })
    after.queue.resume()
    await after.tick()
    expect(after.calls).toEqual([])
    after.gateway({ active_agents: 0 })
    await after.tick()
    await after.tick()
    expect(after.calls).toEqual(['gateway.restart'])
    // Resumed outside any request, it still probes and restarts the profile the update ran under.
    expect(new Set(after.profiles)).toEqual(new Set(['probe:work', 'restart:work']))
    expect(before.calls).toEqual([])
    expect(after.row(id)).toMatchObject({ phase: 'succeeded', detail: 'stash kept' })
  })

  it('quiesce lets a restart in flight finish before Web exits', async () => {
    let finish!: () => void
    const t = setup(undefined, () => new Promise((resolve) => { finish = () => { resolve({ status: 'completed' }) } }))
    t.gateway({ active_agents: 0 })
    const id = t.waiting()
    t.queue.schedule(id, 'default')
    await flush()
    expect(t.row(id)?.phase).toBe('restarting')
    expect(t.queue.restarting()).toBe(true)
    let quiesced = false
    const done = t.queue.quiesce().then(() => { quiesced = true })
    await flush()
    expect(quiesced).toBe(false)
    finish()
    await done
    expect(t.row(id)?.phase).toBe('succeeded')
    expect(t.queue.restarting()).toBe(false)
  })

  it('shares the waiting record with every server owner, so another owner can follow it and restart now', () => {
    const t = setup()
    t.gateway({ active_agents: 1 })
    const id = t.waiting()
    t.queue.schedule(id, 'default')
    const other: UpdateNotificationScope = { owner: 'oidc:other', profile: 'default', serverOwner: true, tab: 'tab-other-owner' }
    t.store.watch(other, id)
    expect(t.store.list(other).tab_update).toMatchObject({ id, phase: 'waiting_for_idle' })
    expect(t.store.action(other, id, GATEWAY_RESTART_NOW)).toMatchObject({ id })
    expect(t.store.list({ owner: 'member', profile: 'default', serverOwner: false }).notifications.some((row) => row.id === id)).toBe(false)
  })

  it('every server shutdown quiesces the queue', async () => {
    const server = await bootTestServer()
    const quiesce = vi.spyOn(server.deps.gatewayRestarts, 'quiesce')
    await server.close()
    expect(quiesce).toHaveBeenCalledOnce()
  })

  it('retries one transient failure and reports a failed restart with the manual command', async () => {
    const outcomes = [{ status: 'failed', message: 'launchd rotating' }, { status: 'completed' }]
    const t = setup(undefined, () => Promise.resolve(outcomes.shift() ?? { status: 'failed', message: 'still down' }))
    t.gateway({ active_agents: 0 })
    const ok = t.waiting()
    t.queue.schedule(ok, 'default')
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart', 'gateway.restart'])
    expect(t.row(ok)?.phase).toBe('succeeded')
    const failed = t.waiting()
    t.queue.schedule(failed, 'default')
    await t.tick()
    await t.tick()
    expect(t.row(failed)).toMatchObject({ phase: 'failed', detail: expect.stringContaining('Run `hermes gateway restart` manually.') as string })
  })
})
