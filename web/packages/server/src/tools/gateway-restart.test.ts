import { initializeStore } from '../test/storage.js'
import { JsonDocuments } from '../test/storage.js'
/** TAL-953: the post-update gateway restart waits for a synthetic gateway's `active_agents` to drain. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Dict } from '../config/agent-config.js'
import type { GatewayLifecycle } from '@maudecode/talaria-web-contracts'
import { GatewayRestartQueue, NOT_CONTROLLED } from './gateway-restart.js'
import { gatewayRestartBlockers, liveGateways } from './health.js'
import { GATEWAY_RESTART_NOW, UpdateNotificationStore, type UpdateNotificationScope } from './update-notifications.js'
import { bootTestServer } from '../test/harness.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const OWNER: UpdateNotificationScope = { owner: 'local-owner', profile: 'default', serverOwner: true }
const NOW = Date.parse('2026-10-13T12:00:00Z') / 1000
const stamp = (offsetS = 0): string => new Date((NOW + offsetS) * 1000).toISOString()
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve) }) }

/** The gateway process a restart replaces, and the one that replaces it: both live, so only identity tells them apart. */
const OLD_PID = process.pid
const NEW_PID = process.ppid

/**
 * A Hermes home with a synthetic gateway, a notification store, and a queue whose polls advance only on `tick()`. The
 * default restart replaces the gateway process (TAL-1138), and the Agent runtime reports ready unless `ready.now` is false.
 */
async function setup(stateDir = mkdtempSync(join(tmpdir(), 'talaria-gateway-restart-')), restart?: (interrupt: boolean) => Promise<Dict>, updating = { now: false }, probe: () => void = () => undefined) {
  dirs.push(stateDir)
  const home = join(stateDir, 'home')
  let last: { pid?: number | null; gateway_state?: string; active_agents?: number; updated_at?: string } = {}
  const gateway = (state: { pid?: number | null; gateway_state?: string; active_agents?: number; updated_at?: string } = {}): void => {
    last = state
    rmSync(home, { recursive: true, force: true })
    mkdirSync(home, { recursive: true })
    if (state.pid !== null) writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: state.pid ?? OLD_PID }))
    writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ gateway_state: state.gateway_state ?? 'running', active_agents: state.active_agents ?? 0, updated_at: state.updated_at ?? stamp() }))
  }
  /** `hermes gateway restart` as the Agent runs it: the old process exits and a new one writes its own pid record. */
  const replaced = (): Promise<Dict> => { if (last.pid !== null) gateway({ ...last, pid: (last.pid ?? OLD_PID) === OLD_PID ? NEW_PID : OLD_PID, active_agents: 0 }); return Promise.resolve({ status: 'completed' }) }
  const store = (await initializeStore(new UpdateNotificationStore(new JsonDocuments(stateDir))))
  const calls: string[] = []
  const interrupts: boolean[] = []
  const profiles: string[] = []
  const waiters: (() => void)[] = []
  const clock = { ms: NOW * 1000 }
  const ready = { now: true }
  /** TAL-1627: the lifecycle capability each restart reads; an Error rejects the read. */
  const control: { now: GatewayLifecycle | Error } = { now: { managed: true, reason: 'local_gateway', start_command: null } }
  const lifecycles: string[] = []
  const queue = new GatewayRestartQueue({
    notifications: store,
    blockers: (profile) => { profiles.push(`probe:${profile}`); const blockers = gatewayRestartBlockers(home, home, NOW); probe(); return blockers },
    restart: (profile, interrupt) => { interrupts.push(interrupt); calls.push('gateway.restart'); profiles.push(`restart:${profile}`); return (restart ?? replaced)(interrupt) },
    gateways: () => liveGateways(home, home, NOW),
    runtimeReady: () => Promise.resolve(ready.now),
    lifecycle: (profile) => { lifecycles.push(profile); return control.now instanceof Error ? Promise.reject(control.now) : Promise.resolve(control.now) },
    updating: () => updating.now,
    sleep: () => new Promise<void>((resolve) => { waiters.push(resolve) }),
    now: () => clock.ms,
    log: () => undefined,
  })
  const tick = async (): Promise<void> => { await flush(); for (const wake of waiters.splice(0)) wake(); await flush() }
  /** What `applyWithNotification` records for a finished Agent update before handing it to the queue. */
  const waiting = async (detail: string | null = null, profile = 'default'): Promise<string> => {
    const row = (await store.begin({ ...OWNER, profile }, 'agent'))
    await store.transition(row.id, 'waiting_for_idle', null, undefined, detail)
    return row.id
  }
  const row = async (id: string) => (await store.list(OWNER)).notifications.find((entry) => entry.id === id)
  return { stateDir, home, gateway, replaced, store, queue, calls, interrupts, profiles, tick, waiting, row, clock, ready, control, lifecycles }
}

describe('gatewayRestartBlockers', () => {
  it('blocks only a live gateway with running work', async () => {
    const t = (await setup())
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
    const t = (await setup())
    t.gateway({ active_agents: 0 })
    writeFileSync(join(t.home, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running', updated_at: stamp() }))
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ active_runs: 0, restart_blocked: true })
    writeFileSync(join(t.home, 'gateway_state.json'), '{not json')
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ restart_blocked: true })
    rmSync(join(t.home, 'gateway_state.json'))
    expect(await gatewayRestartBlockers(t.home, t.home, NOW)).toMatchObject({ restart_blocked: true })
  })

  it('counts both the root host gateway and the named profile\'s own gateway', async () => {
    const t = (await setup())
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
  it.each(['gatewayWaiting', 'transition', 'recordGatewayBaseline'] as const)('releases the waiting slot when %s rejects, so another update can restart', async (method) => {
    const t = await setup()
    t.gateway({ active_agents: 0 })
    const first = await t.waiting()
    vi.spyOn(t.store, method).mockRejectedValueOnce(new Error('synthetic persistence failure'))
    await t.queue.schedule(first, 'default')
    await flush()
    expect(t.queue.pendingId()).toBeNull()
    expect(t.queue.restarting()).toBe(false)
    expect(t.queue.restartNow(first)).toBe(false)
    expect(t.calls).toEqual([])
    const next = await t.waiting()
    expect(await t.queue.schedule(next, 'default')).toBe(next)
    await flush()
    expect(t.calls).toEqual(['gateway.restart'])
    expect((await t.row(next))?.phase).toBe('succeeded')
  })

  it('holds live work absent from active_agents, then retries automatically once it clears', async () => {
    let busy = true
    const t = await setup(undefined, () => busy ? Promise.resolve({ status: 'busy_live_work', reason: 'Refusing to restart the gateway: 1 live session(s) would be interrupted.' }) : t.replaced())
    t.gateway({ active_agents: 0 })
    const id = await t.waiting('kept update detail')
    await t.queue.schedule(id, 'default', 'kept update detail')
    await flush()
    expect(t.queue.pendingId()).toBe(id)
    expect(t.queue.restarting()).toBe(false)
    expect((await t.row(id))).toMatchObject({ phase: 'waiting_for_idle', detail: 'kept update detail', actions: [{ id: GATEWAY_RESTART_NOW }] })
    expect(t.interrupts).toEqual([false])
    busy = false
    await t.tick()
    expect(t.interrupts).toEqual([false, false])
    expect((await t.row(id))?.phase).toBe('succeeded')
    expect(t.queue.pendingId()).toBeNull()
  })

  it('Restart now consents after a live-work refusal', async () => {
    const t = await setup(undefined, (interrupt) => interrupt ? t.replaced() : Promise.resolve({ status: 'busy_live_work' }))
    t.gateway({ active_agents: 0 })
    const id = await t.waiting()
    await t.queue.schedule(id, 'default')
    await flush()
    expect(t.queue.restartNow(id)).toBe(true)
    await flush()
    expect(t.interrupts).toEqual([false, true])
    expect((await t.row(id))?.phase).toBe('succeeded')
  })

  it('holds the restart while the gateway is busy and restarts exactly once when it goes idle', async () => {
    const t = (await setup())
    t.gateway({ active_agents: 2 })
    const id = (await t.waiting())
    expect((await t.queue.schedule(id, 'default'))).toBe(id)
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual([])
    expect((await t.row(id))).toMatchObject({
      phase: 'waiting_for_idle', can_dismiss: false,
      message: 'Waiting for 2 running gateway tasks to finish before restarting the gateway.',
      actions: [{ id: GATEWAY_RESTART_NOW, label: 'Restart now', style: 'destructive', acknowledges: false }],
    })
    t.gateway({ active_agents: 1 })
    await t.tick()
    expect((await t.row(id))?.message).toBe('Waiting for 1 running gateway task to finish before restarting the gateway.')
    t.gateway({ active_agents: 0 })
    await t.tick()
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect((await t.row(id))).toMatchObject({ phase: 'succeeded', actions: [], can_dismiss: true })
  })

  it.each([
    ['stopped', { pid: null, gateway_state: 'stopped', active_agents: 2 }],
    ['stale', { pid: null, active_agents: 2, updated_at: stamp(-600) }],
  ] as const)('restarts a %s gateway immediately', async (_name, state) => {
    const t = (await setup())
    t.gateway(state)
    const id = (await t.waiting())
    await t.queue.schedule(id, 'default')
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect((await t.row(id))?.phase).toBe('succeeded')
  })

  it('Restart now restarts at once while the gateway is still busy and ends the wait', async () => {
    const t = (await setup())
    t.gateway({ active_agents: 3 })
    const id = (await t.waiting())
    await t.queue.schedule(id, 'default')
    await t.tick()
    expect(t.calls).toEqual([])
    expect(t.queue.restartNow('another-id')).toBe(false)
    expect(t.queue.restartNow(id)).toBe(true)
    await flush()
    expect(t.calls).toEqual(['gateway.restart'])
    expect((await t.row(id))?.phase).toBe('succeeded')
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect(t.queue.restartNow(id)).toBe(false)
    expect(t.interrupts).toEqual([true])
  })

  it('starts no restart, even a forced one, while another update changes the Agent source', async () => {
    const updating = { now: true }
    const t = (await setup(undefined, undefined, updating))
    t.gateway({ active_agents: 0 })
    const id = (await t.waiting())
    await t.queue.schedule(id, 'default')
    await t.tick()
    t.queue.restartNow(id)
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual([])
    expect((await t.row(id))?.phase).toBe('waiting_for_idle')
    updating.now = false
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect((await t.row(id))?.phase).toBe('succeeded')
  })

  it('rechecks the update lock after the blocker probe, so an update that starts mid-probe holds the restart', async () => {
    const updating = { now: false }
    let probes = 0
    const t = (await setup(undefined, undefined, updating, () => { probes += 1; if (probes === 1) updating.now = true }))
    t.gateway({ active_agents: 0 })
    const id = (await t.waiting())
    await t.queue.schedule(id, 'default')
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual([])
    expect((await t.row(id))?.phase).toBe('waiting_for_idle')
    updating.now = false
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
  })

  it('a second update while one waits reuses the waiting record instead of starting a second wait', async () => {
    const t = (await setup())
    t.gateway({ active_agents: 1 })
    const first = (await t.waiting())
    await t.queue.schedule(first, 'default')
    const second = (await t.waiting('stash kept'))
    expect((await t.queue.schedule(second, 'default', 'stash kept'))).toBe(first)
    expect((await t.row(second))).toMatchObject({ phase: 'succeeded', actions: [], detail: expect.stringContaining('stash kept') as string })
    t.gateway({ active_agents: 0 })
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect((await t.row(first))?.phase).toBe('succeeded')
  })

  it('a waiting record survives a server restart, and the restarted server resumes it', async () => {
    const before = (await setup())
    before.gateway({ active_agents: 2 })
    const id = (await before.waiting('stash kept', 'work'))
    await before.queue.schedule(id, 'work')
    await before.tick()
    await before.queue.quiesce()
    expect(before.calls).toEqual([])
    const after = (await setup(before.stateDir))
    after.gateway({ active_agents: 2 })
    expect((await after.row(id))).toMatchObject({ phase: 'waiting_for_idle', actions: [{ id: GATEWAY_RESTART_NOW }] })
    await after.queue.resume()
    await after.tick()
    expect(after.calls).toEqual([])
    after.gateway({ active_agents: 0 })
    await after.tick()
    await after.tick()
    expect(after.calls).toEqual(['gateway.restart'])
    // Resumed outside any request, it still probes and restarts the profile the update ran under.
    expect(new Set(after.profiles)).toEqual(new Set(['probe:work', 'restart:work']))
    expect(before.calls).toEqual([])
    expect((await after.row(id))).toMatchObject({ phase: 'succeeded', detail: 'stash kept' })
  })

  it('quiesce lets a restart in flight finish before Web exits, and leaves its check to the next server', async () => {
    let finish!: () => void
    const replace = { now: (): Promise<Dict> => Promise.resolve({ status: 'completed' }) }
    const t = (await setup(undefined, () => new Promise((resolve) => { finish = () => { resolve(replace.now()) } })))
    replace.now = t.replaced
    t.gateway({ active_agents: 0 })
    const id = (await t.waiting())
    await t.queue.schedule(id, 'default')
    await flush()
    expect((await t.row(id))?.phase).toBe('restarting')
    expect(t.queue.restarting()).toBe(true)
    let quiesced = false
    const done = t.queue.quiesce().then(() => { quiesced = true })
    await flush()
    expect(quiesced).toBe(false)
    finish()
    await done
    expect(t.calls).toEqual(['gateway.restart'])
    expect((await t.row(id))?.phase).toBe('verifying')
    expect(t.queue.restarting()).toBe(false)
  })

  it('shares the waiting record with every server owner, so another owner can follow it and restart now', async () => {
    const t = (await setup())
    t.gateway({ active_agents: 1 })
    const id = (await t.waiting())
    await t.queue.schedule(id, 'default')
    const other: UpdateNotificationScope = { owner: 'oidc:other', profile: 'default', serverOwner: true, tab: 'tab-other-owner' }
    await t.store.watch(other, id)
    expect((await t.store.list(other)).tab_update).toMatchObject({ id, phase: 'waiting_for_idle' })
    expect((await t.store.action(other, id, GATEWAY_RESTART_NOW))).toMatchObject({ id })
    expect((await t.store.list({ owner: 'member', profile: 'default', serverOwner: false })).notifications.some((row) => row.id === id)).toBe(false)
  })

  it('every server shutdown quiesces the queue', async () => {
    const server = await bootTestServer()
    const quiesce = vi.spyOn(server.deps.gatewayRestarts, 'quiesce')
    await server.close()
    expect(quiesce).toHaveBeenCalledOnce()
  })

  it('retries one transient failure and reports a failed restart with the manual command', async () => {
    const outcomes = [{ status: 'failed', message: 'launchd rotating' }, { status: 'completed' }]
    const replace = { now: (): Promise<Dict> => Promise.resolve({ status: 'completed' }) }
    const t = (await setup(undefined, () => { const next = outcomes.shift() ?? { status: 'failed', message: 'still down' }; return next.status === 'completed' ? replace.now() : Promise.resolve(next) }))
    replace.now = t.replaced
    t.gateway({ active_agents: 0 })
    const ok = (await t.waiting())
    await t.queue.schedule(ok, 'default')
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart', 'gateway.restart'])
    expect((await t.row(ok))?.phase).toBe('succeeded')
    const failed = (await t.waiting())
    await t.queue.schedule(failed, 'default')
    await t.tick()
    await t.tick()
    expect((await t.row(failed))).toMatchObject({ phase: 'failed', detail: expect.stringContaining('Run `hermes gateway restart` manually.') as string })
  })
})

/** TAL-1627: the post-update restart reads the same lifecycle capability as every explicit restart. */
describe('GatewayRestartQueue lifecycle capability', () => {
  const EXTERNAL: GatewayLifecycle = { managed: false, reason: 'external_gateway', start_command: null }

  it.each([
    ['external', EXTERNAL],
    ['unproven loopback', { managed: false, reason: 'local_gateway_unproven' as const, start_command: 'hermes --profile work gateway start' }],
    ['unknown', new Error('sidecar down')],
  ] as const)('an %s Gateway is never restarted, retried, or reported restarted', async (_name, lifecycle) => {
    const t = await setup()
    t.control.now = lifecycle
    t.gateway({ active_agents: 0 })
    const id = await t.waiting('kept update detail', 'work')
    await t.queue.schedule(id, 'work', 'kept update detail')
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual([])
    expect(t.lifecycles).toEqual(['work'])
    const row = await t.row(id)
    expect(row).toMatchObject({ phase: 'failed', detail: `${NOT_CONTROLLED}\n\nkept update detail` })
    expect(row?.steps.find((step) => step.id === 'gateway_restart')?.state).toBe('failed')
    expect(t.queue.pendingId()).toBeNull()
    expect(t.queue.restartNow(id)).toBe(false)
  })

  it('rereads the capability when the wait ends, so a target changed during the wait is not restarted', async () => {
    const t = await setup()
    t.gateway({ active_agents: 1 })
    const id = await t.waiting()
    await t.queue.schedule(id, 'default')
    await t.tick()
    expect((await t.row(id))?.phase).toBe('waiting_for_idle')
    t.control.now = EXTERNAL
    t.gateway({ active_agents: 0 })
    await t.tick()
    await t.tick()
    expect(t.calls).toEqual([])
    expect((await t.row(id))).toMatchObject({ phase: 'failed', detail: NOT_CONTROLLED })
  })

  it('a resumed wait reads the capability again before restarting', async () => {
    const t = await setup()
    t.control.now = EXTERNAL
    t.gateway({ active_agents: 0 })
    const id = await t.waiting()
    await t.queue.resume()
    await t.tick()
    expect(t.calls).toEqual([])
    expect((await t.row(id))?.phase).toBe('failed')
  })

  it('a controlled Gateway still restarts and verifies as before', async () => {
    const t = await setup()
    t.gateway({ active_agents: 0 })
    const id = await t.waiting()
    await t.queue.schedule(id, 'default')
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect((await t.row(id))?.phase).toBe('succeeded')
  })
})

/** TAL-1138: a gateway restart succeeds only once a new gateway process is alive and the Agent runtime answers. */
describe('GatewayRestartQueue readiness', () => {
  it.each([
    ['still restarting in the background', { status: 'in_progress' }],
    ['exited 0 while the old process still runs', { status: 'completed' }],
  ] as const)('a restart %s does not reach succeeded, and the 90 s window ends it failed', async (_name, outcome) => {
    const t = (await setup(undefined, () => Promise.resolve(outcome)))
    t.gateway({ active_agents: 0 })
    const id = (await t.waiting())
    await t.queue.schedule(id, 'default')
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect((await t.row(id))).toMatchObject({ phase: 'verifying', active: true })
    t.clock.ms += 89_000
    await t.tick()
    expect((await t.row(id))?.phase).toBe('verifying')
    t.clock.ms += 1_000
    await t.tick()
    expect((await t.row(id))).toMatchObject({ phase: 'failed', detail: 'Hermes Agent was updated, but the gateway did not come back. Run `hermes gateway restart` manually.' })
    expect(t.queue.restarting()).toBe(false)
  })

  it('waits for the new gateway process and the Agent runtime before succeeding', async () => {
    const t = (await setup(undefined, () => Promise.resolve({ status: 'in_progress' })))
    t.gateway({ active_agents: 0 })
    t.ready.now = false
    const id = (await t.waiting('stash kept'))
    await t.queue.schedule(id, 'default', 'stash kept')
    await t.tick()
    expect((await t.row(id))?.phase).toBe('verifying')
    await t.replaced()
    await t.tick()
    expect((await t.row(id))?.phase).toBe('verifying')
    t.ready.now = true
    await t.tick()
    expect((await t.row(id))).toMatchObject({ phase: 'succeeded', detail: 'stash kept' })
  })

  it('a dead gateway after the restart does not count as back', async () => {
    const t = (await setup(undefined, () => { t.gateway({ pid: 2 ** 22 + 12345 }); return Promise.resolve({ status: 'completed' }) }))
    t.gateway({ active_agents: 0 })
    const id = (await t.waiting())
    await t.queue.schedule(id, 'default')
    await t.tick()
    t.clock.ms += 90_000
    await t.tick()
    expect((await t.row(id))?.phase).toBe('failed')
  })

  it('a gateway that was not running needs only the Agent runtime', async () => {
    const t = (await setup())
    rmSync(t.home, { recursive: true, force: true })
    const id = (await t.waiting())
    await t.queue.schedule(id, 'default')
    await t.tick()
    await t.tick()
    expect((await t.row(id))?.phase).toBe('succeeded')
  })

  it('Web exiting mid-check leaves the record verifying, and the restarted server finishes the check', async () => {
    const before = (await setup(undefined, () => Promise.resolve({ status: 'in_progress' })))
    before.gateway({ active_agents: 0 })
    before.ready.now = false
    const id = (await before.waiting(null, 'work'))
    await before.queue.schedule(id, 'work')
    await before.tick()
    await before.queue.quiesce()
    expect((await before.row(id))?.phase).toBe('verifying')
    const after = (await setup(before.stateDir))
    await after.replaced()
    await after.queue.resume()
    await after.tick()
    expect(after.calls).toEqual([])
    expect((await after.row(id))?.phase).toBe('succeeded')
  })

  it('verifies a native Agent update the server did not restart itself against the gateways from before the update', async () => {
    const t = (await setup())
    t.gateway({ active_agents: 0 })
    const id = (await t.waiting())
    const baseline = (await t.queue.gateways('default'))
    expect(baseline).toHaveLength(1)
    await t.store.transition(id, 'verifying')
    t.ready.now = true
    void t.queue.verify(id, 'default', baseline, null)
    await t.tick()
    expect((await t.row(id))?.phase).toBe('verifying')
    await t.replaced()
    await t.tick()
    expect((await t.row(id))?.phase).toBe('succeeded')
    expect(t.calls).toEqual([])
  })

  it('a resumed check without its recorded gateways fails closed instead of passing vacuously', async () => {
    const t = (await setup())
    t.gateway({ active_agents: 0 })
    const id = (await t.waiting())
    await t.store.transition(id, 'verifying')
    await t.queue.resume()
    await t.tick()
    expect((await t.row(id))).toMatchObject({ phase: 'failed', detail: expect.stringContaining('could not be verified') as string })
  })
})
