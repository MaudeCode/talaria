import { vi } from 'vitest'

// vi.waitFor's 1 s default is a short deadline of its own: a request that outlasts it on a loaded runner fails the
// test (TAL-2583). Every wait defaults to one ceiling, kept below the 20 s testTimeout so a wait that never settles
// still reports its last assertion rather than a bare test timeout.
const waitFor = vi.waitFor
vi.waitFor = (callback, options) => waitFor(callback, typeof options === 'number' ? options : { timeout: 15_000, ...options })
