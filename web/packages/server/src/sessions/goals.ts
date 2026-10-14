import type { SessionGoal, SidecarResult } from '@maudecode/talaria-web-contracts'

type GoalStatus = SidecarResult<'goals.get'>

/** Past the deadline, so the Agent's own clock agrees the park ended. */
const PARK_END_MARGIN_MS = 500

/**
 * TAL-808: the session `goal` view of the Agent's `goals.get`. A timed park whose deadline passed is active again (the
 * Agent lifts it at its next judgement); a done, cleared or absent goal is null.
 */
export function sessionGoalView(status: GoalStatus, now: number): SessionGoal | null {
  const goal = status.goal
  if (!goal || (goal.status !== 'active' && goal.status !== 'paused')) return null
  const base = { text: goal.goal, turns_used: goal.turns_used, max_turns: goal.max_turns }
  if (goal.status === 'paused') return { ...base, status: 'paused', reason: goal.paused_reason || null, parked_until: null }
  const parked = status.parked
  if (parked && (parked.until === null || parked.until > now)) return { ...base, status: 'parked', reason: parked.reason, parked_until: parked.until }
  return { ...base, status: 'active', reason: null, parked_until: null }
}

/**
 * TAL-808: the last `goals.get` per session, refreshed after `/goal` and each goal judgement.
 * ponytail: in memory; a session's first load after a restart reads it once, and a goal changed from another surface shows
 * after this server's next refresh.
 */
export class SessionGoals {
  private readonly bySession = new Map<string, GoalStatus>()
  private readonly parkTimers = new Map<string, NodeJS.Timeout>()
  /** The view each session last reported, so a park that lapsed since counts as a change. */
  private readonly reported = new Map<string, string>()

  constructor(private readonly now: () => number) {}

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  view(sessionId: string): SessionGoal | null {
    const status = this.bySession.get(sessionId)
    return status ? sessionGoalView(status, this.now()) : null
  }

  /** Stores the session's status; true when its view differs from the one it last reported. */
  set(sessionId: string, status: GoalStatus): boolean {
    this.bySession.set(sessionId, status)
    const view = JSON.stringify(this.view(sessionId))
    // A session that never had one starts with none.
    if ((this.reported.get(sessionId) ?? 'null') === view) return false
    this.reported.set(sessionId, view)
    return true
  }

  /**
   * Runs `reread` just after the session's timed park ends, replacing any earlier one. A timer that fires early finds the
   * park still running, and the re-read schedules the next one.
   */
  rereadAfterPark(sessionId: string, reread: () => void): void {
    clearTimeout(this.parkTimers.get(sessionId))
    this.parkTimers.delete(sessionId)
    const until = this.view(sessionId)?.parked_until
    if (until === null || until === undefined) return
    const timer = setTimeout(() => { this.parkTimers.delete(sessionId); reread() }, Math.max(0, until - this.now()) * 1000 + PARK_END_MARGIN_MS)
    timer.unref()
    this.parkTimers.set(sessionId, timer)
  }

  sweep(exists: (sessionId: string) => boolean): void {
    for (const sid of this.bySession.keys()) {
      if (exists(sid)) continue
      this.bySession.delete(sid)
      this.reported.delete(sid)
      clearTimeout(this.parkTimers.get(sid))
      this.parkTimers.delete(sid)
    }
  }
}
