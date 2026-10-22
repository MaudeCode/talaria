import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { keys } from './queryKeys'
import { invalidateSessionQueries } from './sessionQueries'

it('refreshes list, search and only the named session, with an explicit option to retain detail', async () => {
  const qc = new QueryClient()
  const queries = [keys.sessions.list({}), keys.sessions.search('answer', {}), keys.sessions.detail('changed'), keys.background('changed'), keys.sessions.detail('other')]
  const fetches = queries.map(() => vi.fn(() => Promise.resolve({})))
  const release = queries.map((queryKey, i) => new QueryObserver(qc, { queryKey, initialData: {}, staleTime: Infinity, queryFn: fetches[i]! }).subscribe(() => undefined))
  try {
    await invalidateSessionQueries(qc, 'changed')
    expect(fetches.map((fetch) => fetch.mock.calls.length)).toEqual([1, 1, 1, 1, 0])
    await invalidateSessionQueries(qc, 'changed', { detail: false })
    expect(fetches.map((fetch) => fetch.mock.calls.length)).toEqual([2, 2, 1, 2, 0])
    await invalidateSessionQueries(qc)
    expect(fetches.map((fetch) => fetch.mock.calls.length)).toEqual([3, 3, 1, 2, 0])
  } finally { release.forEach((unsubscribe) => unsubscribe()); qc.clear() }
})
