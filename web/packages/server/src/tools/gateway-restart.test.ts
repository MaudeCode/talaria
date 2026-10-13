/** TAL-953: the post-update gateway restart waits for a synthetic gateway's `active_agents` to drain. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Dict } from '../config/agent-config.js'
import { GatewayRestartQueue } from './gateway-restart.js'
import { gatewayRestartBlockers } from './health.js'
import { GATEWAY_RESTART_NOW, UpdateNotificationStore, type UpdateNotificationScope } from './update-notifications.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const OWNER: UpdateNotificationScope = { owner: 'local-owner', profile: 'default', serverOwner: true }
const NOW = Date.parse('2026-10-13T12:00:00Z') / 1000
const stamp = (offsetS = 0): string => new Date((NOW + offsetS) * 1000).toISOString()
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve) }) }

/** A Hermes home with a synthetic gateway, a notification store, and a queue whose polls advance only on `tick()`. */
function setup(stateDir = mkdtempSync(join(tmpdir(), 'talaria-gateway-restart-')), restart: () => Promise<Dict> = () => Promise.resolve({ status: 'completed' }), updating = { now: false }) {
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
  const waiters: (() => void)[] = []
  const queue = new GatewayRestartQueue({
    notifications: store,
    blockers: () => gatewayRestartBlockers(home, home, NOW),
    restart: () => { calls.push('gateway.restart'); return restart() },
    updating: () => updating.now,
    sleep: () => new Promise<void>((resolve) => { waiters.push(resolve) }),
    log: () => undefined,
  })
  const tick = async (): Promise<void> => { await flush(); for (const wake of waiters.splice(0)) wake(); await flush() }
  /** What `applyWithNotification` records for a finished Agent update before handing it to the queue. */
  const waiting = (detail: string | null = null): string => {
    const row = store.begin(OWNER, 'agent')
    store.transition(row.id, 'waiting_for_idle', null, undefined, detail)
    return row.id
  }
  const row = (id: string) => store.list(OWNER).notifications.find((entry) => entry.id === id)
  return { stateDir, home, gateway, store, queue, calls, tick, waiting, row }
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
})

describe('GatewayRestartQueue', () => {
  it('holds the restart while the gateway is busy and restarts exactly once when it goes idle', async () => {
    const t = setup()
    t.gateway({ active_agents: 2 })
    const id = t.waiting()
    expect(t.queue.schedule(id)).toBe(id)
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
    t.queue.schedule(id)
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart'])
    expect(t.row(id)?.phase).toBe('succeeded')
  })

  it('Restart now restarts at once while the gateway is still busy and ends the wait', async () => {
    const t = setup()
    t.gateway({ active_agents: 3 })
    const id = t.waiting()
    t.queue.schedule(id)
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
    t.queue.schedule(id)
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

  it('a second update while one waits reuses the waiting record instead of starting a second wait', async () => {
    const t = setup()
    t.gateway({ active_agents: 1 })
    const first = t.waiting()
    t.queue.schedule(first)
    const second = t.waiting('stash kept')
    expect(t.queue.schedule(second, 'stash kept')).toBe(first)
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
    const id = before.waiting('stash kept')
    before.queue.schedule(id)
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
    expect(before.calls).toEqual([])
    expect(after.row(id)).toMatchObject({ phase: 'succeeded', detail: 'stash kept' })
  })

  it('quiesce lets a restart in flight finish before Web exits', async () => {
    let finish!: () => void
    const t = setup(undefined, () => new Promise((resolve) => { finish = () => { resolve({ status: 'completed' }) } }))
    t.gateway({ active_agents: 0 })
    const id = t.waiting()
    t.queue.schedule(id)
    await flush()
    expect(t.row(id)?.phase).toBe('restarting')
    let quiesced = false
    const done = t.queue.quiesce().then(() => { quiesced = true })
    await flush()
    expect(quiesced).toBe(false)
    finish()
    await done
    expect(t.row(id)?.phase).toBe('succeeded')
  })

  it('retries one transient failure and reports a failed restart with the manual command', async () => {
    const outcomes = [{ status: 'failed', message: 'launchd rotating' }, { status: 'completed' }]
    const t = setup(undefined, () => Promise.resolve(outcomes.shift() ?? { status: 'failed', message: 'still down' }))
    t.gateway({ active_agents: 0 })
    const ok = t.waiting()
    t.queue.schedule(ok)
    await t.tick()
    expect(t.calls).toEqual(['gateway.restart', 'gateway.restart'])
    expect(t.row(ok)?.phase).toBe('succeeded')
    const failed = t.waiting()
    t.queue.schedule(failed)
    await t.tick()
    await t.tick()
    expect(t.row(failed)).toMatchObject({ phase: 'failed', detail: expect.stringContaining('Run `hermes gateway restart` manually.') as string })
  })
})
