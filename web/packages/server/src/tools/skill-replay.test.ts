import { expect, it } from 'vitest'
import { replayBudget } from './skill-replay.js'

it('reserves a finite budget whose per-call reservations cannot exceed the consented cost', () => {
  const budget = replayBudget([{ input_tokens_bound: 2000 }, { input_tokens_bound: 5000 }], 1500, 0.5)!
  expect(budget).toMatchObject({ max_calls: 4, max_output_tokens: 1500, max_input_tokens: 14_000 })
  const reserved = [2000, 2000, 5000, 5000].reduce((sum, bound) => sum + (bound + 1500) * budget.max_price_per_million / 1e6, 0)
  expect(reserved).toBeLessThanOrEqual(0.5)
  expect(replayBudget([], 1500, 0.5)).toBeNull()
  expect(replayBudget([{ input_tokens_bound: 1 }], 1500, 6)).toBeNull()
})
