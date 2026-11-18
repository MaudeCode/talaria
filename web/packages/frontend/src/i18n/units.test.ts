import { describe, expect, it } from 'vitest'
import { formatElapsed } from './units'

describe('formatElapsed (TAL-2321)', () => {
  it.each([
    [0, '<1s'], [0.04, '<1s'], [0.99, '<1s'], [1.4, '1s'], [59.6, '1m'], [61, '1m 1s'], [120, '2m'], [3_725, '1h 2m'],
  ])('reads %s seconds as %s, in whole units', (seconds, text) => {
    expect(formatElapsed('en-US', seconds)).toBe(text)
  })

  it('drops the seconds past a minute for a live timer', () => {
    expect(formatElapsed('en-US', 61, false)).toBe('1m')
  })

  it('uses the locale\'s narrow units', () => {
    expect([formatElapsed('de-DE', 0.04), formatElapsed('de-DE', 61)]).toEqual(['<1 Sek.', '1 Min. 1 Sek.'])
  })
})
