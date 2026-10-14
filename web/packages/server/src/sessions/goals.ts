import type { SessionGoal, SidecarResult } from '@maudecode/talaria-web-contracts'

type GoalStatus = SidecarResult<'goals.get'>

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

  constructor(private readonly now: () => number) {}

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  view(sessionId: string): SessionGoal | null {
    const status = this.bySession.get(sessionId)
    return status ? sessionGoalView(status, this.now()) : null
  }

  /** Stores the session's status; true when its view changed. */
  set(sessionId: string, status: GoalStatus): boolean {
    const before = JSON.stringify(this.view(sessionId))
    this.bySession.set(sessionId, status)
    return JSON.stringify(this.view(sessionId)) !== before
  }

  sweep(exists: (sessionId: string) => boolean): void {
    for (const sid of this.bySession.keys()) if (!exists(sid)) this.bySession.delete(sid)
  }
}
