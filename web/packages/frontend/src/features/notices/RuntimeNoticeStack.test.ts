import { describe, expect, it } from 'vitest'
import { retryDelay } from './RuntimeNoticeStack'

describe('retryDelay', () => {
  it('waits 1 s after the first failure and doubles to a 30 s cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  })
})
