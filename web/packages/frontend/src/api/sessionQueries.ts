import type { QueryClient } from '@tanstack/react-query'

/** Extend the sidebar's scoped refresh to mutations and streams; other sessions keep their cached queries. */
export function invalidateSessionQueries(qc: QueryClient, sessionId?: string | null, { detail = true } = {}): Promise<void> {
  return qc.invalidateQueries({ predicate: ({ queryKey: [root, kind, id] }) => root === 'sessions' && (
    kind === 'list' || kind === 'search' || (!!sessionId && id === sessionId && (detail || kind !== 'detail'))
  ) })
}
