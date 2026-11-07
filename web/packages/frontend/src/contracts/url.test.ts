import { describe, expect, it } from 'vitest'
import { parseAppSearch, stringifyAppSearch } from './url'

/** TAL-1898: a hex project ID can read as a JSON number, and the URL still carries it bare. */
const numberLike = ['589985371805', '9235168978e0']

describe('app search serialization', () => {
  it.each(numberLike)('writes project %s without quotes and reads it back exactly', (id) => {
    const url = stringifyAppSearch({ project: id })
    expect(url).toBe(`?project=${id}`)
    expect(parseAppSearch(url)).toEqual({ project: id })
  })

  it.each(numberLike)('still resolves project %s from an old quoted URL', (id) => {
    expect(parseAppSearch(`?project=%22${id}%22`)).toEqual({ project: id })
  })

  it('escapes a project next to other params and leaves their JSON handling alone', () => {
    const url = stringifyAppSearch({ project: 'a b&c', tail: 100, job: '123' })
    expect(url).toContain('job=%22123%22')
    expect(parseAppSearch(url)).toEqual({ project: 'a b&c', tail: 100, job: '123' })
  })
})
