/**
 * TAL-1274: the low-disk session auto-prune question every Agent surface asks (Agent v0.22.3 `hermes_cli.prune_advisor`),
 * asked as a profile notification. The Agent decides whether to ask and words it (`state_db.prune_advice`); its actions run
 * the Agent's own `/autoprune on|off|later`.
 */
import type { SidecarLike } from '../sidecar/client.js'
import type { PublicUpdateNotification, UpdateNotificationAction, UpdateNotificationScope, UpdateNotificationStore } from './update-notifications.js'

export const AUTO_PRUNE_KIND = 'auto_prune'
/** The Agent's `prune_advisor.SNOOZE_SECONDS`: `/autoprune later` quiets the question this long. */
export const AUTO_PRUNE_WINDOW_S = 7 * 86400
const CHOICES: Record<string, string> = { autoprune_on: 'on', autoprune_off: 'off', autoprune_later: 'later' }
const ACTIONS: UpdateNotificationAction[] = [
  { id: 'autoprune_on', label: 'Turn on', style: 'primary', acknowledges: true },
  { id: 'autoprune_off', label: 'Keep everything', style: 'default', acknowledges: true },
  { id: 'autoprune_later', label: 'Later', style: 'default', acknowledges: true },
]

export interface PruneAdviceDeps {
  sidecar: () => SidecarLike | null
  /** Every Agent profile, the root as `default`, with its home. */
  profiles: () => { name: string; home: string }[]
  /** The profile's write lease (`ProfileService.beginWrite`): deletion waits for it, and it is refused while deletion runs. */
  lease: (name: string) => Promise<(() => void) | 'deleting' | 'missing' | 'unreadable'>
  notifications: UpdateNotificationStore
  /** Seconds. */
  now: () => number
  log: (line: string) => void
}

export type PruneAnswer = { notification: PublicUpdateNotification } | { refused: string }

export class PruneAdvice {
  /** When each profile was last checked in this process. */
  private readonly checked = new Map<string, number>()
  /** Questions an answer is running for; a second answer is refused until the first settles. */
  private readonly answering = new Set<string>()
  /** The tail of each profile's checks and answers, which run one at a time. */
  private readonly queues = new Map<string, Promise<unknown>>()
  constructor(private readonly deps: PruneAdviceDeps) {}

  /** Run after every earlier check or answer for `name` settles, so neither changes a question under the other. */
  private serialized<T>(name: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(name) ?? Promise.resolve()).then(run, run)
    const tail = next.catch(() => undefined)
    this.queues.set(name, tail)
    void tail.then(() => { if (this.queues.get(name) === tail) this.queues.delete(name) })
    return next
  }

  /** A hygiene sweep: each profile is checked once per process start and once per window; a failed check retries next sweep. */
  async sweep(): Promise<void> {
    const now = this.deps.now()
    for (const { name, home } of this.deps.profiles()) {
      const last = this.checked.get(name)
      if (last !== undefined && now - last < AUTO_PRUNE_WINDOW_S) continue
      if (await this.check(name, home)) this.checked.set(name, now)
    }
  }

  /** Answer the open question `id` with an action; null when `id` is no open auto-prune question this scope sees. */
  async answer(scope: UpdateNotificationScope, id: string, actionId: string, home: string): Promise<PruneAnswer | null> {
    const choice = CHOICES[actionId]
    if (!choice || !this.deps.notifications.openQuestion(scope, id, AUTO_PRUNE_KIND)) return null
    const sidecar = this.deps.sidecar()
    if (!sidecar) return { refused: 'Hermes Agent is not running.' }
    // Reserved before the first await, so two answers can never both run: the recorded answer is the one the Agent saved.
    if (this.answering.has(id)) return { refused: 'This question is already being answered.' }
    this.answering.add(id)
    try {
      return await this.serialized(scope.rootProfile ? 'default' : scope.profile, async () => {
        // A check that ran first may have withdrawn the question (answered elsewhere): nothing is left to answer.
        if (!this.deps.notifications.openQuestion(scope, id, AUTO_PRUNE_KIND)) return null
        const { output } = await sidecar.call('commands.exec', { profile_home: home, command: `/autoprune ${choice}` }, { timeoutMs: 120_000 })
        // The Agent stops asking only once it saved the answer; a config it could not write keeps it asking.
        if ((await sidecar.call('state_db.prune_advice', { profile_home: home }, { timeoutMs: 120_000 })).advice) return { refused: output }
        const notification = await this.deps.notifications.answerQuestion(scope, id, AUTO_PRUNE_KIND, actionId, output)
        return notification ? { notification } : null
      })
    } finally {
      this.answering.delete(id)
    }
  }

  /** A deleted profile: its next check is due at once, and its profile notifications are gone. */
  async forget(name: string): Promise<void> {
    this.checked.delete(name)
    // The profile is already gone: notifications that could not be dropped must not fail its deletion.
    try { await this.deps.notifications.forgetProfile(name) } catch (error) { this.deps.log(`[webui] WARNING: notifications for deleted profile ${name} were kept: ${(error as Error).message}`) }
  }

  /** Ask or withdraw one profile's question now; also run after `/autoprune` from the composer, outside the window. False when the Agent did not answer. */
  check(name: string, home: string): Promise<boolean> {
    return this.serialized(name, () => this.checkNow(name, home))
  }

  private async checkNow(name: string, home: string): Promise<boolean> {
    const sidecar = this.deps.sidecar()
    if (sidecar?.status !== 'ready') return false
    // Held across the Agent read and the question it records, so a deleted profile never gets one.
    const release = await this.deps.lease(name)
    if (typeof release !== 'function') return false
    try {
      const { advice } = await sidecar.call('state_db.prune_advice', { profile_home: home }, { timeoutMs: 120_000 })
      // The message names the low disk and what turning auto-prune on deletes, so a client that shows only the message
      // still asks for an informed answer; the estimate and the commands follow in the detail.
      const lines = advice?.lines ?? []
      const message = lines.slice(0, 2).join(' ')
      const detail = lines.slice(2)
      await this.deps.notifications.profileQuestion(name, AUTO_PRUNE_KIND, advice ? {
        kind: AUTO_PRUNE_KIND, phase: 'awaiting_confirmation', severity: 'warning', title: 'Session auto-prune', message, detail: detail.join('\n'), actions: ACTIONS,
      } : null)
      return true
    } catch (error) {
      this.deps.log(`[webui] WARNING: auto-prune advice for profile ${name} failed: ${(error as Error).message}`)
      return false
    } finally {
      release()
    }
  }
}
