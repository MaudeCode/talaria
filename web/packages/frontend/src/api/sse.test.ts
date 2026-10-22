import { afterEach, expect, it, vi } from 'vitest'
import { openSessionStream } from './sse'

vi.unmock('./sse')

afterEach(() => vi.unstubAllGlobals())

it('sends the cached persisted count, including zero, without inventing a missing count', () => {
  const urls: URL[] = []
  vi.stubGlobal('EventSource', class extends EventTarget {
    constructor(url: string) { super(); urls.push(new URL(url)) }
    close = vi.fn()
  })
  const cb = { onEvent: vi.fn() }
  openSessionStream('windowed', cb, 241).close()
  openSessionStream('empty', cb, 0).close()
  openSessionStream('uncached', cb).close()
  expect(urls.map((url) => url.searchParams.get('known_count'))).toEqual(['241', '0', null])
})
