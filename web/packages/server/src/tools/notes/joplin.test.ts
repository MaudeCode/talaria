import { describe, expect, it } from 'vitest'
import { joplinSearch } from './joplin.js'
import { NotesSourceError } from './source.js'

describe('Joplin client', () => {
  it('turns a timeout into a fixed "not reachable" failure [py:test_joplin_api_get_converts_bare_timeout_to_valueerror]', async () => {
    let signal: AbortSignal | null | undefined
    const timedOut: typeof fetch = (_input, init) => { signal = init?.signal; return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) }
    const deps = { config: { mcp_servers: { joplin: { env: { JOPLIN_TOKEN: 'secret-token' } } } }, env: {}, fetch: timedOut, redact: true }
    const error = await joplinSearch(deps, 'hello world', 20).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NotesSourceError)
    expect((error as Error).message).toBe('Joplin API is not reachable')
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})
