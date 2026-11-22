import type { GatewayLifecycle } from '@maudecode/talaria-web-contracts'
import type { Dict } from '../config/agent-config.js'
import type { SidecarLike } from '../sidecar/client.js'
import { str } from '../util.js'
import type { GatewayProcess } from './health.js'
import { gatewayRestartOffer, gatewayTarget, type GatewayRestartOffer, type UpdateNotificationStore } from './update-notifications.js'
import { waitUntilRestartSafe, type RestartBlockers } from './updates.js'

export interface GatewayRestartQueueDeps {
  notifications: Pick<UpdateNotificationStore, 'transition' | 'gatewayWaiting' | 'pendingGatewayRestarts' | 'recordGatewayBaseline'>
  /** `gatewayRestartBlockers` for the profile whose update owns the restart. */
  blockers: (profile: string) => Promise<RestartBlockers>
  /** Sidecar `gateway.restart` (`hermes gateway restart`) for that profile. */
  restart: (profile: string, interrupt: boolean) => Promise<Dict>
  /** TAL-1138: `liveGateways` for that profile: the gateway processes a restart must replace. */
  gateways: (profile: string) => Promise<GatewayProcess[]>
  /** TAL-1138: the server's Agent runtime check (sidecar `runtime.status`) reports compatible and not stale. */
  runtimeReady: () => Promise<boolean>
  /** TAL-1627: whether Web's local gateway CLI controls the Gateway it monitors for that profile. */
  lifecycle: (profile: string) => Promise<GatewayLifecycle>
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
export const restartGateway = (sidecar: SidecarLike, profileHome: string, interrupt: boolean) => sidecar.call('gateway.restart', { profile_home: profileHome, interrupt }, { timeoutMs: 0 })

const IDLE: RestartBlockers = { active_streams: 0, active_runs: 0, blocking_stream_ids: [], blocking_run_ids: [], restart_blocked: false }
const HELD: RestartBlockers = { ...IDLE, restart_blocked: true }
const REUSED = 'The gateway restart from an earlier Hermes Agent update is still waiting, and it loads this update too.'
const NOT_BACK = 'Hermes Agent was updated, but the gateway did not come back. Run `hermes gateway restart` manually.'
const UNVERIFIABLE = 'Hermes Agent was updated, but the gateway restart could not be verified. Run `hermes gateway restart` manually.'
/** TAL-1627: the post-update restart skipped a Gateway Web does not control. */
export const NOT_CONTROLLED = 'Hermes Agent was updated, but Talaria does not control the gateway it monitors, so that gateway was not restarted. Restart it where it runs.'
/** TAL-2625: a forced attempt found the gateway or its running work changed from what Restart now was shown for. */
const STALE = 'confirmation_stale'
const READY_WINDOW_MS = 90_000
const READY_POLL_MS = 1_000

/** TAL-1138: every gateway that ran before the restart now runs as a new process (another pid, or the same pid started again). */
const replaced = (before: GatewayProcess[], after: GatewayProcess[]): boolean =>
  before.every((old) => after.some((now) => now.dir === old.dir && (now.pid !== old.pid || (now.start_time !== null && now.start_time !== old.start_time))))

/**
 * A waiting restart. `forced`: the Restart now offer the user confirmed, which every forced launch rechecks (TAL-2625);
 * `woken` settles when Restart now ends the wait, and is renewed when a stale confirmation returns it to waiting.
 */
interface PendingRestart { id: string; profile: string; forced: GatewayRestartOffer | null; woken: Promise<void>; wake: () => void }

interface GatewayState { blockers: RestartBlockers; gateways: GatewayProcess[] }

const wakeable = (): Pick<PendingRestart, 'woken' | 'wake'> => {
  let wake = (): void => undefined
  const woken = new Promise<void>((resolve) => { wake = resolve })
  return { woken, wake }
}

/**
 * TAL-953: after an Agent update, restart the messaging gateway only once its own work drains, so its shutdown never
 * runs into the Agent CLI's kill deadline. The update notification in `waiting_for_idle` is the persisted record: at
 * most one waits at a time, a restarted server resumes it, and its Restart now action ends the wait at once.
 */
export class GatewayRestartQueue {
  private pending: PendingRestart | null = null
  private inFlight: Promise<unknown> | null = null
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
    const pending: PendingRestart = { id, profile, forced: null, ...wakeable() }
    this.pending = pending
    void this.run(pending, detail)
      .catch((error: unknown) => { this.deps.log(`[updates] gateway restart failed: ${(error as Error).message}`) })
      .finally(() => { if (this.pending === pending) this.pending = null })
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

  /**
   * The Restart now action `actionId`: restart while the gateway is still busy. TAL-2625: only while the gateway is the
   * one the action was shown for and runs no more tasks than it showed; otherwise `stale`, with a fresh action offered.
   * `not_waiting` when `id` is not the waiting restart.
   */
  async restartNow(id: string, actionId: string): Promise<'restarting' | 'stale' | 'not_waiting'> {
    const pending = this.pending
    if (pending?.id !== id) return 'not_waiting'
    const offer = gatewayRestartOffer(actionId)
    const confirmed = await this.confirms(pending, offer)
    if (this.pending !== pending) return 'not_waiting'
    if (!confirmed || !offer) return 'stale'
    pending.forced = offer
    pending.wake()
    return 'restarting'
  }

  /** Before Web exits: start no restart, and let one in flight finish so the sidecar is not killed under it. A waiting record stays for the next process. */
  async quiesce(): Promise<void> {
    this.stopped = true
    this.stop()
    this.pending?.wake()
    while (this.inFlight) await this.inFlight
  }

  private async run(pending: PendingRestart, detail: string | null): Promise<void> {
    if (await this.uncontrolled(pending, detail)) return
    while (!this.stopped) {
      // An update can take the source lock while a blocker probe is in flight: recheck it before restarting.
      await this.waitForIdle(pending)
      if (this.stopped) return
      if (this.deps.updating?.()) continue
      const restart = this.restartGateway(pending, detail)
      this.inFlight = restart
      let held: boolean
      try { held = await restart } finally { if (this.inFlight === restart) this.inFlight = null }
      if (!held) return
      // A CLI refusal covers work not counted by active_agents. Keep the record and poll without a hot retry loop.
      await Promise.race([this.sleep(this.deps.pollMs ?? READY_POLL_MS), pending.forced ? this.stopping : pending.woken, this.stopping])
    }
  }

  private async waitForIdle(pending: PendingRestart): Promise<void> {
    await waitUntilRestartSafe(async () => {
      if (this.stopped) return IDLE
      if (this.deps.updating?.()) return HELD
      if (pending.forced) return IDLE
      let gateway: GatewayState
      // An unreadable gateway state keeps waiting rather than restarting over running work.
      try { gateway = await this.read(pending) } catch (error) { this.deps.log(`[updates] gateway restart blockers unavailable: ${(error as Error).message}`); return HELD }
      await this.show(pending, gateway)
      return gateway.blockers
    }, { maxWaitMs: Infinity, ...(this.deps.pollMs ? { pollMs: this.deps.pollMs } : {}), sleep: (ms) => pending.forced ? this.sleep(ms) : Promise.race([this.sleep(ms), pending.woken]) })
    while (this.inFlight) await this.inFlight
  }

  /** The gateway's running work and live processes now. */
  private async read(pending: PendingRestart): Promise<GatewayState> {
    const [blockers, gateways] = await Promise.all([this.deps.blockers(pending.profile), this.deps.gateways(pending.profile)])
    return { blockers, gateways }
  }

  /** A waiting record shows the running work with a Restart now versioned by it and the live processes (TAL-2625). */
  private show(pending: PendingRestart, gateway: GatewayState): Promise<void> {
    return this.deps.notifications.gatewayWaiting(pending.id, gateway.blockers.active_runs, gateway.gateways)
  }

  /** TAL-2625: Restart now `offer` still covers the gateway: the same processes, running no more tasks than it showed. */
  private async confirms(pending: PendingRestart, offer: GatewayRestartOffer | null): Promise<boolean> {
    try {
      const gateway = await this.read(pending)
      await this.show(pending, gateway)
      return offer !== null && gatewayTarget(gateway.gateways) === offer.target && gateway.blockers.active_runs <= offer.tasks
    } catch (error) {
      this.deps.log(`[updates] gateway restart confirmation unavailable: ${(error as Error).message}`)
      return false
    }
  }

  /** TAL-2625: before a forced launch, drop a confirmation the gateway no longer matches; the wait resumes and offers a fresh one. */
  private async stillForced(pending: PendingRestart): Promise<boolean> {
    if (!pending.forced || (await this.confirms(pending, pending.forced))) return true
    this.deps.log('[updates] the gateway changed after Restart now; waiting for a fresh confirmation')
    Object.assign(pending, { forced: null }, wakeable())
    return false
  }

  /**
   * TAL-1627: a Gateway Web does not control (or whose control is unknown) is never restarted, retried, or reported
   * restarted: the record fails at the restart step with the reason, and the waiting slot is released.
   */
  private async uncontrolled(pending: PendingRestart, detail: string | null): Promise<boolean> {
    let managed = false
    try { managed = (await this.deps.lifecycle(pending.profile)).managed } catch (error) { this.deps.log(`[updates] gateway lifecycle unavailable: ${(error as Error).message}`) }
    if (managed) return false
    this.deps.log('[updates] the post-update gateway restart was skipped: Talaria does not control that gateway')
    if (this.pending === pending) this.pending = null
    await this.deps.notifications.transition(pending.id, 'restarting')
    await this.deps.notifications.transition(pending.id, 'failed', null, undefined, [NOT_CONTROLLED, detail].filter(Boolean).join('\n\n'))
    return true
  }

  private async restartGateway(pending: PendingRestart, detail: string | null): Promise<boolean> {
    const { id, profile } = pending
    if (await this.uncontrolled(pending, detail)) return false
    if (!(await this.stillForced(pending))) return true
    await this.deps.notifications.transition(id, 'restarting')
    const baseline = await this.deps.gateways(profile)
    await this.deps.notifications.recordGatewayBaseline(id, baseline)
    const [ok, gateway] = await this.attempt(pending)
    this.deps.log(`[updates] gateway restart after the Agent update: ${str(gateway.status) || 'failed'}`)
    if (gateway.status === 'busy_live_work' || gateway.status === STALE) {
      await this.deps.notifications.transition(id, 'waiting_for_idle', null, undefined, detail)
      // Offer Restart now for the gateway as it is now; an unreadable one is offered by the wait's next probe.
      try { await this.show(pending, await this.read(pending)) } catch (error) { this.deps.log(`[updates] gateway restart blockers unavailable: ${(error as Error).message}`) }
      return true
    }
    // A completed attempt releases the waiting slot; an update installed during verification needs its own restart.
    if (this.pending === pending) this.pending = null
    // TAL-1138: the CLI returning (or still restarting in the background) is not success; the new gateway and the Agent must answer.
    if (ok) {
      await this.deps.notifications.transition(id, 'verifying', null, undefined, detail)
      await this.checkReady(id, profile, baseline, detail)
      return false
    }
    const failure = gateway.message ? `Hermes Agent was updated, but the gateway restart did not complete: ${str(gateway.message)}. Run \`hermes gateway restart\` manually.` : 'Hermes Agent was updated, but the gateway restart did not complete. Run `hermes gateway restart` manually.'
    await this.deps.notifications.transition(id, 'failed', null, undefined, [failure, detail].filter(Boolean).join('\n\n'))
    return false
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

  /**
   * Python `_ensure_gateway_restart_for_agent_update`: retry once after a transient supervisor handoff failure.
   * TAL-2625: a forced retry first rechecks the confirmed gateway, as `restartGateway` did before the first launch.
   */
  private async attempt(pending: PendingRestart): Promise<[boolean, Dict]> {
    const attempt = async (): Promise<Dict> => { try { return await this.deps.restart(pending.profile, pending.forced !== null) } catch (error) { return { status: 'failed', message: (error as Error).message } } }
    const first = await attempt()
    const status = str(first.status)
    if (status === 'completed' || status === 'in_progress') return [true, first]
    if (status !== 'failed') return [false, first]
    await this.sleep(1000)
    if (!(await this.stillForced(pending))) return [false, { status: STALE }]
    const retry = await attempt()
    const retryStatus = str(retry.status)
    const annotated = { ...retry, retry_attempted: true, initial_failure: first.message }
    if (retryStatus === 'completed' || retryStatus === 'in_progress') return [true, annotated]
    if (retryStatus !== 'failed') return [false, annotated]
    return [false, { ...annotated, message: `${str(first.message) || 'Restart failed'}; recovery retry did not complete: ${str(retry.message) || 'retry did not complete'}` }]
  }
}
