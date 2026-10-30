import { QueryClient, dehydrate, hydrate, type DehydratedState, type Query } from '@tanstack/react-query'
import { z, type ZodType } from 'zod'
import { isApiError } from '../contracts/common'
import { ProfilesSchema, ProjectsSchema, ReasoningStatusSchema, SessionEnvelopeSchema, SessionsListSchema, SettingsSchema, WorkspacesSchema } from '../contracts'
import { FEEDBACK_DRAFT_KEY } from '../contracts/persisted'
import { readPersisted, readPersistedJson, removePersisted, removePersistedByPrefix, writePersisted, writePersistedJson } from '../lib/persisted'
import { randomHex } from '../lib/randomHex'

/**
 * Boot snapshot of the queries that paint the shell (sidebar list, the last
 * open transcript, settings, profiles, workspaces, projects). Hydrated before
 * the first render so a reload or a return to the last session paints the
 * final layout at once; every entry is stale on arrival and refetches on mount.
 * The legacy app kept the same data as HTML snapshots under `hermes-boot:*`
 * (login and logout clear that prefix).
 */
const SNAPSHOT_KEY = 'hermes-boot:queries'
// Outside the cleared prefix so old tabs retain a durable revocation fence.
const GENERATION_KEY = 'hermes-boot-generation'
const SNAPSHOT_LIMIT = 2_000_000
const retireClients = new Set<() => void>()

/** Retire the previous identity's readers and writers before navigating. */
export function resetIdentityCache(): void {
  const generation = randomHex()
  writePersisted(GENERATION_KEY, generation)
  for (const retire of retireClients) retire()
  removePersistedByPrefix('hermes-boot:')
  removePersistedByPrefix('hermes-webui-session')
  removePersisted(FEEDBACK_DRAFT_KEY)
  // Removing the old snapshot can free the quota that blocked the fence write. Reads prefer a refused write's
  // in-memory copy, so retry unconditionally: rewriting an unchanged value notifies no other tab.
  writePersisted(GENERATION_KEY, generation)
}

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
  generation: z.string().nullable().optional(),
  queries: z.array(z.looseObject({ queryKey: z.array(z.unknown()), queryHash: z.string(), state: z.looseObject({ data: z.unknown(), dataUpdatedAt: z.number(), status: z.literal('success') }) })),
})

function restoreSnapshot(qc: QueryClient, generation: string | null): void {
  const snap = readPersistedJson(SNAPSHOT_KEY, DehydratedSchema)
  if (!snap || (snap.generation ?? null) !== generation) return
  const queries = snap.queries.filter((q) => snapshotSchema(q.queryKey)?.safeParse(q.state.data).success)
  hydrate(qc, { queries, mutations: [] } as unknown as DehydratedState)
}

function persistSnapshot(qc: QueryClient, generation: string | null): void {
  const keep = (q: Query) => q.state.status === 'success' && snapshotSchema(q.queryKey) !== null
  let state = { ...dehydrate(qc, { shouldDehydrateQuery: keep }), generation }
  // Over budget: the transcript is the only entry that grows; drop it and keep the shell queries.
  if (JSON.stringify(state).length > SNAPSHOT_LIMIT) state = { ...dehydrate(qc, { shouldDehydrateQuery: (q) => keep(q) && q.queryKey[1] !== 'detail' }), generation }
  if (JSON.stringify(state).length <= SNAPSHOT_LIMIT && readPersisted(GENERATION_KEY) === generation) writePersistedJson(SNAPSHOT_KEY, state)
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
    const generation = readPersisted(GENERATION_KEY)
    restoreSnapshot(qc, generation)
    let timer: number | undefined
    let retired = false
    const retire = () => {
      retired = true
      window.clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('pagehide', persist)
      window.removeEventListener('storage', onStorage)
      retireClients.delete(retire)
      qc.clear()
    }
    const isCurrent = () => {
      if (!retired && readPersisted(GENERATION_KEY) !== generation) {
        retire()
        // Mounted observers need a fresh client after another tab changes identity.
        window.location.reload()
      }
      return !retired
    }
    const persist = () => { if (isCurrent()) persistSnapshot(qc, generation) }
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === GENERATION_KEY || ev.key === null) isCurrent()
    }
    const unsubscribe = qc.getQueryCache().subscribe((ev) => {
      if (ev.type !== 'updated' || ev.action.type !== 'success') return
      if (!isCurrent()) return
      window.clearTimeout(timer)
      timer = window.setTimeout(persist, 500)
    })
    retireClients.add(retire)
    window.addEventListener('pagehide', persist)
    window.addEventListener('storage', onStorage)
  }
  return qc
}
