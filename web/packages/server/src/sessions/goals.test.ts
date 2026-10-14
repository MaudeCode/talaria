import { describe, expect, it } from 'vitest'
import { sessionGoalView } from './goals.js'

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
