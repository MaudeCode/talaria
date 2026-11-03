import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSessionMessagesAppendOnly } from './merge.js'
import { stateDbMessageKey } from './state-db-identity.js'

vi.mock('./state-db-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state-db-identity.js')>()
  return { ...actual, stateDbMessageKey: vi.fn(actual.stateDbMessageKey) }
})

// TAL-1740: a merge serialises a local row's content only when a state.db row shares its role and timestamp.
describe('mergeSessionMessagesAppendOnly content keys (TAL-1740)', () => {
  const keyed = vi.mocked(stateDbMessageKey)
  const local = Array.from({ length: 1600 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `row ${i} `.repeat(50), timestamp: i }))
  // Only these local rows share a role and timestamp with a state.db row below.
  const sharing = [1598, 1599]
  const replay = (id?: number) => ({ ...local[1598], ...(id ? { _state_db_row_id: id } : {}) })
  const sameBucket = (id?: number) => ({ role: 'assistant', content: 'CLI edit', timestamp: 1599, ...(id ? { _state_db_row_id: id } : {}) })
  const cliTurn = (id?: number) => ({ role: 'user', content: 'CLI turn', timestamp: 2000, ...(id ? { _state_db_row_id: id } : {}) })
  const identity = { mode: 'identity', state: [replay(11), sameBucket(12), cliTurn(13)], opts: { stateDbSeenId: 10 }, appended: [sameBucket(12), cliTurn(13)] }
  const legacy = { mode: 'legacy', state: [replay(), sameBucket(), cliTurn()], opts: {}, appended: [cliTurn()] }
  beforeEach(() => { keyed.mockClear() })

  it.each([identity, legacy])('keys only local rows sharing a state row bucket ($mode)', ({ state, opts, appended }) => {
    expect(mergeSessionMessagesAppendOnly(local, state, opts)).toEqual([...local, ...appended])
    const localKeyed = keyed.mock.calls.map(([m]) => local.indexOf(m as never)).filter((i) => i >= 0)
    expect(localKeyed).toHaveLength(sharing.length)
    expect(localKeyed).toEqual(sharing)
  })

  // An archived source key makes the legacy merge fingerprint every row, the path that also builds the replay keys.
  const sourced = { mode: 'legacy with a source key', state: [replay(), sameBucket(), { ...cliTurn(), _state_db_source_key: 'unmatched' }], opts: {}, appended: [{ ...cliTurn(), _state_db_source_key: 'unmatched' }] }
  it.each([identity, sourced])('computes no row key twice in one merge ($mode)', ({ state, opts, appended }) => {
    expect(mergeSessionMessagesAppendOnly(local, state, opts)).toEqual([...local, ...appended])
    const rows = keyed.mock.calls.map(([m]) => m)
    expect(rows.length).toBe(new Set(rows).size)
  })
})
