import { QueryClient, dehydrate, hydrate, type DehydratedState, type Query } from '@tanstack/react-query'
import { z, type ZodType } from 'zod'
import { isApiError } from '../contracts/common'
import { ProfilesSchema, ProjectsSchema, ReasoningStatusSchema, SessionEnvelopeSchema, SessionsListSchema, SettingsSchema, WorkspacesSchema } from '../contracts'
import { readPersisted, readPersistedJson, writePersistedJson } from '../lib/persisted'

/**
 * Boot snapshot of the queries that paint the shell (sidebar list, the last
 * open transcript, settings, profiles, workspaces, projects). Hydrated before
 * the first render so a reload or a return to the last session paints the
 * final layout at once; every entry is stale on arrival and refetches on mount.
 * The legacy app kept the same data as HTML snapshots under `hermes-boot:*`
 * (login and logout clear that prefix).
 */
const SNAPSHOT_KEY = 'hermes-boot:queries'
const SNAPSHOT_LIMIT = 2_000_000

function snapshotSchema(key: readonly unknown[]): ZodType | null {
  switch (key[0]) {
    case 'settings': return SettingsSchema
    case 'profiles': return ProfilesSchema
    case 'workspaces': return WorkspacesSchema
    case 'projects': return ProjectsSchema
    case 'reasoning': return ReasoningStatusSchema
    case 'sessions':
      if (key[1] === 'list') return SessionsListSchema
      if (key[1] === 'detail' && key[2] === readPersisted('hermes-webui-session')) return SessionEnvelopeSchema
      return null
    default: return null
  }
}

const DehydratedSchema = z.object({
  queries: z.array(z.looseObject({ queryKey: z.array(z.unknown()), queryHash: z.string(), state: z.looseObject({ data: z.unknown(), dataUpdatedAt: z.number(), status: z.literal('success') }) })),
})

function restoreSnapshot(qc: QueryClient): void {
  const snap = readPersistedJson(SNAPSHOT_KEY, DehydratedSchema)
  if (!snap) return
  const queries = snap.queries.filter((q) => snapshotSchema(q.queryKey)?.safeParse(q.state.data).success)
  hydrate(qc, { queries, mutations: [] } as unknown as DehydratedState)
}

function persistSnapshot(qc: QueryClient): void {
  const keep = (q: Query) => q.state.status === 'success' && snapshotSchema(q.queryKey) !== null
  let state = dehydrate(qc, { shouldDehydrateQuery: keep })
  // Over budget: the transcript is the only entry that grows; drop it and keep the shell queries.
  if (JSON.stringify(state).length > SNAPSHOT_LIMIT) state = dehydrate(qc, { shouldDehydrateQuery: (q) => keep(q) && q.queryKey[1] !== 'detail' })
  if (JSON.stringify(state).length <= SNAPSHOT_LIMIT) writePersistedJson(SNAPSHOT_KEY, state)
}

export function createQueryClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          if (isApiError(error)) return error.retryable && failureCount < 2
          return failureCount < 1
        },
        throwOnError: false,
      },
      mutations: { retry: 0 },
    },
  })
  if (typeof window !== 'undefined') {
    restoreSnapshot(qc)
    let timer: number | undefined
    qc.getQueryCache().subscribe((ev) => {
      if (ev.type !== 'updated' || ev.action.type !== 'success') return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => persistSnapshot(qc), 500)
    })
    window.addEventListener('pagehide', () => persistSnapshot(qc))
  }
  return qc
}
