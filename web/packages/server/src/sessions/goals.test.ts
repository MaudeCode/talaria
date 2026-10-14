import { describe, expect, it, vi } from 'vitest'
import { SessionGoals, sessionGoalView } from './goals.js'

const goal = { goal: 'Ship it', status: 'active', turns_used: 2, max_turns: 20, last_verdict: null, last_reason: null, paused_reason: null }

describe('sessionGoalView (TAL-808)', () => {
  it('shows a timed park until its deadline, then the goal as active', () => {
    const status = { goal, active: true, parked: { reason: 'CI running', until: 1_000 }, message: '' }
    expect(sessionGoalView(status, 999)).toMatchObject({ status: 'parked', reason: 'CI running', parked_until: 1_000 })
    expect(sessionGoalView(status, 1_000)).toMatchObject({ status: 'active', reason: null, parked_until: null })
  })

  it('has no goal once it is done or cleared', () => {
    for (const s of ['done', 'cleared']) expect(sessionGoalView({ goal: { ...goal, status: s }, active: false, parked: null, message: '' }, 0)).toBeNull()
  })
})

describe('SessionGoals (TAL-808)', () => {
  it('re-reads once just after a timed park ends, and reports the lapsed park as a change', () => {
    vi.useFakeTimers()
    try {
      const now = 100
      const goals = new SessionGoals(() => now)
      const parked = { goal, active: true, parked: { reason: 'CI running', until: 101 }, message: '' }
      expect(goals.set('s1', parked)).toBe(true)
      expect(goals.set('s1', parked)).toBe(false)
      const reread = vi.fn()
      goals.rereadAfterPark('s1', reread)
      goals.rereadAfterPark('s1', reread)
      vi.advanceTimersByTime(1_499)
      expect(reread).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(reread).toHaveBeenCalledTimes(1)
      // The Agent lifted the barrier: the goal shows as active again.
      expect(goals.set('s1', { ...parked, parked: null })).toBe(true)
      goals.rereadAfterPark('s1', reread)
      vi.advanceTimersByTime(10_000)
      expect(reread).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})
