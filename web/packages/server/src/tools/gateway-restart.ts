import type { Dict } from '../config/agent-config.js'
import type { SidecarLike } from '../sidecar/client.js'
import { str } from '../util.js'
import type { GatewayProcess } from './health.js'
import type { UpdateNotificationStore } from './update-notifications.js'
import { waitUntilRestartSafe, type RestartBlockers } from './updates.js'

export interface GatewayRestartQueueDeps {
  notifications: Pick<UpdateNotificationStore, 'transition' | 'gatewayWaiting' | 'pendingGatewayRestarts' | 'recordGatewayBaseline'>
  /** `gatewayRestartBlockers` for the profile whose update owns the restart. */
  blockers: (profile: string) => Promise<RestartBlockers>
  /** Sidecar `gateway.restart` (`hermes gateway restart`) for that profile. */
  restart: (profile: string) => Promise<Dict>
  /** TAL-1138: `liveGateways` for that profile: the gateway processes a restart must replace. */
  gateways: (profile: string) => Promise<GatewayProcess[]>
  /** TAL-1138: the server's Agent runtime check (sidecar `runtime.status`) reports compatible and not stale. */
  runtimeReady: () => Promise<boolean>
  /** An update is changing the Agent source; no restart, even a forced one, starts mid-checkout. */
  updating?: () => boolean
  pollMs?: number
  /** TAL-1138: how long a restarted gateway and the Agent runtime have to answer; 90 s by default. */
  readyWindowMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log: (line: string) => void
}

/**
 * TAL-894: sidecar `gateway.restart` for a profile home. The sidecar bounds the wait by the Agent CLI's own restart budget
 * (30 min by default); a client timeout here would cancel the call, and with it terminate the restart mid-drain.
 */
export const restartGateway = (sidecar: SidecarLike, profileHome: string) => sidecar.call('gateway.restart', { profile_home: profileHome }, { timeoutMs: 0 })

const IDLE: RestartBlockers = { active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }
const HELD: RestartBlockers = { ...IDLE, restart_blocked: true }
const REUSED = 'The gateway restart from an earlier Hermes Agent update is still waiting, and it loads this update too.'
const NOT_BACK = 'Hermes Agent was updated, but the gateway did not come back. Run `hermes gateway restart` manually.'
const UNVERIFIABLE = 'Hermes Agent was updated, but the gateway restart could not be verified. Run `hermes gateway restart` manually.'
const READY_WINDOW_MS = 90_000
const READY_POLL_MS = 1_000

/** TAL-1138: every gateway that ran before the restart now runs as a new process (another pid, or the same pid started again). */
const replaced = (before: GatewayProcess[], after: GatewayProcess[]): boolean =>
  before.every((old) => after.some((now) => now.dir === old.dir && (now.pid !== old.pid || (now.start_time !== null && now.start_time !== old.start_time))))

/**
 * TAL-953: after an Agent update, restart the messaging gateway only once its own work drains, so its shutdown never
 * runs into the Agent CLI's kill deadline. The update notification in `waiting_for_idle` is the persisted record: at
 * most one waits at a time, a restarted server resumes it, and its Restart now action ends the wait at once.
 */
export class GatewayRestartQueue {
  private pending: { id: string; profile: string; forced: boolean; wake: () => void } | null = null
  private inFlight: Promise<void> | null = null
  private stopped = false
  private stop = (): void => undefined
  private readonly stopping = new Promise<void>((resolve) => { this.stop = resolve })
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly deps: GatewayRestartQueueDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = deps.now ?? Date.now
  }

  /** TAL-1138: the gateway processes running now, the baseline a later check needs a new process for. */
  gateways(profile: string): Promise<GatewayProcess[]> { return this.deps.gateways(profile) }

  /** A gateway restart is running; the Agent source must not change until it settles. */
  restarting(): boolean { return this.inFlight !== null }

  /** The waiting restart's notification id, if one waits. */
  pendingId(): string | null { return this.pending?.id ?? null }

  /**
   * Wait on notification `id`, already `waiting_for_idle`, then restart `profile`'s gateway, the profile the update ran
   * under (persisted on the record, since a resumed wait runs outside any request). A waiting restart is reused: `id`
   * closes as covered by it, and its id is returned.
   */
  async schedule(id: string, profile: string, detail: string | null = null): Promise<string> {
    if (this.pending) {
      if (this.pending.id !== id) (await this.deps.notifications.transition(id, 'succeeded', null, undefined, [REUSED, detail].filter(Boolean).join('\n\n')))
      return this.pending.id
    }
    let wake = (): void => undefined
    const woken = new Promise<void>((resolve) => { wake = resolve })
    const pending = { id, profile, forced: false, wake }
    this.pending = pending
    void this.run(pending, woken, detail).catch((error: unknown) => { this.deps.log(`[updates] gateway restart failed: ${(error as Error).message}`) })
    return id
  }

  /** Resume the waits and checks a previous server process recorded; the newest wait carries any older ones. */
  async resume(): Promise<void> {
    for (const row of this.deps.notifications.pendingGatewayRestarts()) {
      // Without the gateways recorded before the restart, no check can prove they came back: fail closed.
      if (row.phase === 'verifying' && row.baseline === null) (await this.deps.notifications.transition(row.id, 'failed', null, undefined, [UNVERIFIABLE, row.detail].filter(Boolean).join('\n\n')))
      else if (row.phase === 'verifying') void this.verify(row.id, row.profile, row.baseline ?? [], row.detail)
      else (await this.schedule(row.id, row.profile, row.detail))
    }
  }

  /**
   * TAL-1138: check notification `id`, already `verifying`, until the gateways in `baseline` run as new processes and
   * the Agent runtime answers, then mark it succeeded; after the bounded window it fails with the manual command. It
   * counts as a restart in flight. A Web exit ends the check early and leaves the record for the next process.
   */
  verify(id: string, profile: string, baseline: GatewayProcess[], detail: string | null): Promise<void> {
    const check = this.inFlight ?? Promise.resolve()
    const run = check.then(() => this.checkReady(id, profile, baseline, detail)).catch((error: unknown) => { this.deps.log(`[updates] gateway readiness check failed: ${(error as Error).message}`) })
    this.inFlight = run
    return run.finally(() => { if (this.inFlight === run) this.inFlight = null })
  }

  /** The Restart now action: restart while the gateway is still busy. False when `id` is not the waiting restart. */
  restartNow(id: string): boolean {
    if (this.pending?.id !== id) return false
    this.pending.forced = true
    this.pending.wake()
    return true
  }

  /** Before Web exits: start no restart, and let one in flight finish so the sidecar is not killed under it. A waiting record stays for the next process. */
  async quiesce(): Promise<void> {
    this.stopped = true
    this.stop()
    this.pending?.wake()
    while (this.inFlight) await this.inFlight
  }

  private async run(pending: { id: string; profile: string; forced: boolean }, woken: Promise<void>, detail: string | null): Promise<void> {
    // An update can take the source lock while a blocker probe is in flight: recheck it right before restarting.
    do await this.waitForIdle(pending, woken)
    while (!this.stopped && this.deps.updating?.())
    if (this.stopped) return
    // Cleared before the restart starts, so an update installed meanwhile waits for its own restart.
    this.pending = null
    const restart = this.restartGateway(pending, detail)
    this.inFlight = restart
    await restart
    if (this.inFlight === restart) this.inFlight = null
  }

  private async waitForIdle(pending: { id: string; profile: string; forced: boolean }, woken: Promise<void>): Promise<void> {
    await waitUntilRestartSafe(async () => {
      if (this.stopped) return IDLE
      if (this.deps.updating?.()) return HELD
      if (pending.forced) return IDLE
      let blockers: RestartBlockers
      // An unreadable gateway state keeps waiting rather than restarting over running work.
      try { blockers = await this.deps.blockers(pending.profile) } catch (error) { this.deps.log(`[updates] gateway restart blockers unavailable: ${(error as Error).message}`); return HELD }
      await this.deps.notifications.gatewayWaiting(pending.id, blockers.active_runs)
      return blockers
    }, { maxWaitMs: Infinity, ...(this.deps.pollMs ? { pollMs: this.deps.pollMs } : {}), sleep: (ms) => pending.forced ? this.sleep(ms) : Promise.race([this.sleep(ms), woken]) })
    while (this.inFlight) await this.inFlight
  }

  private async restartGateway({ id, profile }: { id: string; profile: string }, detail: string | null): Promise<void> {
    await this.deps.notifications.transition(id, 'restarting')
    const baseline = await this.deps.gateways(profile)
    await this.deps.notifications.recordGatewayBaseline(id, baseline)
    const [ok, gateway] = await this.attempt(profile)
    this.deps.log(`[updates] gateway restart after the Agent update: ${str(gateway.status) || 'failed'}`)
    // TAL-1138: the CLI returning (or still restarting in the background) is not success; the new gateway and the Agent must answer.
    if (ok) {
      await this.deps.notifications.transition(id, 'verifying', null, undefined, detail)
      await this.checkReady(id, profile, baseline, detail)
      return
    }
    const failure = gateway.message ? `Hermes Agent was updated, but the gateway restart did not complete: ${str(gateway.message)}. Run \`hermes gateway restart\` manually.` : 'Hermes Agent was updated, but the gateway restart did not complete. Run `hermes gateway restart` manually.'
    await this.deps.notifications.transition(id, 'failed', null, undefined, [failure, detail].filter(Boolean).join('\n\n'))
  }

  private async checkReady(id: string, profile: string, baseline: GatewayProcess[], detail: string | null): Promise<void> {
    const deadline = this.now() + (this.deps.readyWindowMs ?? READY_WINDOW_MS)
    while (!this.stopped) {
      let ready = false
      try { ready = replaced(baseline, await this.deps.gateways(profile)) && (await this.deps.runtimeReady()) } catch (error) { this.deps.log(`[updates] gateway readiness unavailable: ${(error as Error).message}`) }
      if (ready) { (await this.deps.notifications.transition(id, 'succeeded', null, undefined, detail)); return }
      if (this.now() >= deadline) {
        this.deps.log('[updates] the gateway did not come back after the Agent update')
        await this.deps.notifications.transition(id, 'failed', null, undefined, [NOT_BACK, detail].filter(Boolean).join('\n\n'))
        return
      }
      await Promise.race([this.sleep(this.deps.pollMs ?? READY_POLL_MS), this.stopping])
    }
  }

  /** Python `_ensure_gateway_restart_for_agent_update`: retry once after a transient supervisor handoff failure. */
  private async attempt(profile: string): Promise<[boolean, Dict]> {
    const attempt = async (): Promise<Dict> => { try { return await this.deps.restart(profile) } catch (error) { return { status: 'failed', message: (error as Error).message } } }
    const first = await attempt()
    const status = str(first.status)
    if (status === 'completed' || status === 'in_progress') return [true, first]
    if (status !== 'failed') return [false, first]
    await this.sleep(1000)
    const retry = await attempt()
    const retryStatus = str(retry.status)
    const annotated = { ...retry, retry_attempted: true, initial_failure: first.message }
    if (retryStatus === 'completed' || retryStatus === 'in_progress') return [true, annotated]
    if (retryStatus !== 'failed') return [false, annotated]
    return [false, { ...annotated, message: `${str(first.message) || 'Restart failed'}; recovery retry did not complete: ${str(retry.message) || 'retry did not complete'}` }]
  }
}
