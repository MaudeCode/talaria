import type { QueryClient } from '@tanstack/react-query'

/** The sidebar's rows: every list and search read. */
export const isSessionListKey = ([root, kind]: readonly unknown[]): boolean => root === 'sessions' && (kind === 'list' || kind === 'search')

/**
 * Extend the sidebar's scoped refresh to mutations and streams; other sessions keep their cached queries.
 * `list: false` leaves the sidebar rows to the stream's paced refresh (TAL-2261).
 */
export function invalidateSessionQueries(qc: QueryClient, sessionId?: string | null, { detail = true, list = true } = {}): Promise<void> {
  return qc.invalidateQueries({ predicate: ({ queryKey }) => {
    const [root, kind, id] = queryKey
    return (list && isSessionListKey(queryKey)) || (root === 'sessions' && !!sessionId && id === sessionId && (detail || kind !== 'detail'))
  } })
}
