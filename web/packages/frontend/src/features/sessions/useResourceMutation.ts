import { useMemo } from 'react'
import { matchQuery, useMutation, useQuery, useQueryClient, type QueryKey, type QueryClient, type Query } from '@tanstack/react-query'
import { getStreamContext } from '../../stream/connection'
import { keys } from '../../api/queryKeys'
import * as api from '../../api/endpoints'
import { isDefiniteRefusal } from '../../contracts/common'
import { m } from '../../paraglide/messages.js'

/**
 * The display result of a user's own write, shown before the server confirms it (root rule: optimistic writes).
 * Never merge these fields into cached server snapshots; the display helpers below overlay them.
 */
export interface ResourceEffect<T = unknown> {
  /** The row is gone from every list and detail. */
  remove?: boolean
  /** The requested value of a single-value resource (a switch, a selection, a status). */
  value?: T
  /** Row fields as the write sets them (title, name, color, pinned, project_id, status, …). */
  fields?: Record<string, unknown>
}
interface OwnedEffect extends ResourceEffect { context: object; exclusive: boolean; settled: Promise<unknown> }
const effectKey = ['resource-effects'] as const
const empty: Record<string, OwnedEffect> = {}
/** Extend the existing key selection with an exact snapshot match when descendants are unrelated. */
type ResourceRead = QueryKey | { queryKey: QueryKey; exact: boolean }
interface Reconciliation {
  context: object
  requested: number
  requests: { current: () => boolean; resource: string; readKeys: ResourceRead[] | undefined }[]
  promise: Promise<void>
}
const reconciliations = new WeakMap<QueryClient, Map<string, Reconciliation>>()

export function useResourceEffects<T = unknown>(): Record<string, ResourceEffect<T>> {
  const { data } = useQuery({ queryKey: effectKey, queryFn: () => empty, initialData: empty, enabled: false, gcTime: Infinity, structuralSharing: false })
  const context = getStreamContext()
  return useMemo(() => Object.fromEntries(Object.entries(data).filter(([, effect]) => effect.context === context)) as Record<string, ResourceEffect<T>>, [data, context])
}

/** One row as the user's pending writes show it: `null` when removed, fields patched. */
export function withEffect<R extends object>(row: R, effect: ResourceEffect | undefined): R | null {
  if (!effect) return row
  if (effect.remove) return null
  return effect.fields ? { ...row, ...effect.fields } : row
}

/** Server rows as the user's pending writes show them: removed ids dropped, fields patched. */
export function withEffects<R extends object>(rows: readonly R[], resource: (row: R) => string, effects: Record<string, ResourceEffect>): R[] {
  return rows.flatMap((row) => withEffect(row, effects[resource(row)]) ?? [])
}

/** Cancellation and refetch must cover the same required snapshots. */
function resourceReadFilter(readKeys?: ResourceRead[]) {
  return readKeys ? { predicate: (query: Query) => readKeys.some((key) => matchQuery('queryKey' in key ? key : { queryKey: key }, query)) } : {}
}

function readQueryKeys(queryKey?: QueryKey) {
  return queryKey ? [queryKey] : [keys.sessions.all, keys.projects]
}

function cancelResourceReads(qc: QueryClient, queryKey?: QueryKey, readKeys?: ResourceRead[]) {
  return Promise.all(readQueryKeys(queryKey).map((queryKey) => qc.cancelQueries({ queryKey, ...resourceReadFilter(readKeys) })))
}

async function reconcile(qc: QueryClient, current: () => boolean, resource: string, queryKey?: QueryKey, readKeys?: ResourceRead[]) {
  if (!current()) return
  const context = getStreamContext()
  const group = JSON.stringify(queryKey ?? ['resources'])
  let queues = reconciliations.get(qc)
  if (!queues) { queues = new Map(); reconciliations.set(qc, queues) }
  const previous = queues.get(group)
  if (previous?.context === context) {
    previous.requested += 1
    previous.requests.push({ current, resource, readKeys })
    // Supersede the shared read, while every owner waits for the covering follow-up.
    const pendingKeys = previous.requests.some((request) => !request.readKeys) ? undefined : previous.requests.flatMap((request) => request.readKeys ?? [])
    await cancelResourceReads(qc, queryKey, pendingKeys)
    return previous.promise
  }
  const queue = { context, requested: 1, requests: [{ current, resource, readKeys }], promise: Promise.resolve() }
  queue.promise = Promise.resolve().then(async () => {
    try {
      let served = 0
      while (served < queue.requested && queues.get(group) === queue && context === getStreamContext()) {
        const requested = queue.requested
        const requests = queue.requests.filter((request) => request.current())
        const resource = requests.find((request) => request.resource.startsWith('project:'))?.resource ?? requests[0]?.resource
        if (!resource) return
        // Concurrent owners share one pass over the union of their required snapshots.
        const readKeys = requests.some((request) => !request.readKeys) ? undefined : requests.flatMap((request) => request.readKeys ?? [])
        try {
          await reconcileSnapshot(qc, () => requests.some((request) => request.current()), resource, queryKey, readKeys)
        } catch (error) {
          if (requested === queue.requested) throw error
        }
        served = requested
      }
    } finally {
      if (queues.get(group) === queue) queues.delete(group)
    }
  })
  queues.set(group, queue)
  return queue.promise
}

async function reconcileSnapshot(qc: QueryClient, current: () => boolean, resource: string, queryKey?: QueryKey, readKeys?: ResourceRead[]) {
  if (!current()) return
  // Cancel reads captured before the write, including inactive detail/search queries.
  await cancelResourceReads(qc, queryKey, readKeys)
  if (!current()) return
  if (queryKey) {
    await qc.invalidateQueries({ queryKey, refetchType: 'all', ...resourceReadFilter(readKeys) }, { throwOnError: true })
    return
  }
  const projects = qc.getQueryCache().find({ queryKey: keys.projects, exact: true })
  await Promise.all([
    qc.invalidateQueries({ queryKey: keys.sessions.all }, { throwOnError: true }),
    typeof projects?.options.queryFn === 'function'
      ? qc.invalidateQueries({ queryKey: keys.projects, refetchType: 'all' }, { throwOnError: true })
      : resource.startsWith('project:') ? qc.query({ queryKey: keys.projects, queryFn: api.fetchProjects, staleTime: 0 }) : Promise.resolve(),
  ])
}

/** After a failed reconciliation the effect stays until any later successful read of the covered snapshots. */
function settleOnNextRead(qc: QueryClient, current: () => boolean, clear: () => void, queryKey?: QueryKey, readKeys?: ResourceRead[]) {
  const filter = resourceReadFilter(readKeys)
  const covered = (query: Query) => readQueryKeys(queryKey).some((key) => matchQuery({ queryKey: key }, query)) && (!filter.predicate || filter.predicate(query))
  const unsubscribe = qc.getQueryCache().subscribe((event) => {
    if (!current()) { unsubscribe(); return }
    if (event.type === 'updated' && event.action.type === 'success' && covered(event.query as Query)) { unsubscribe(); clear() }
  })
}

/**
 * One optimistic owner per resource across sidebar, menus and detail; independent resources proceed concurrently.
 * The effect shows at once. Success keeps it until a fresh read confirms the server value, a definite refusal rolls
 * it back at once, and an unknown outcome keeps it while a fresh read decides. A repeated write to the same resource
 * replaces the shown result and runs after its predecessor (last write wins); an `exclusive` write (create, delete)
 * is never queued behind or replayed over another, and refuses with `resource_change_busy` instead.
 */
export function useResourceMutation<V, R, T = unknown>(options: {
  resource: (variables: V) => string | string[]
  effect: (variables: V) => ResourceEffect<T>
  exclusive?: boolean
  queryKey?: QueryKey
  readKeys?: (variables: V) => ResourceRead[]
  mutationFn: (variables: V) => Promise<R>
  onSuccess?: (result: R, variables: V) => void
  onError?: (error: unknown) => void
}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (variables: V) => {
      qc.setQueryDefaults(effectKey, { structuralSharing: false })
      const resources = options.resource(variables)
      const ids = typeof resources === 'string' ? [resources] : resources
      const id = ids[0]
      if (id === undefined) throw new Error(m.error_generic())
      const context = getStreamContext()
      const effects = () => qc.getQueryData<Record<string, OwnedEffect>>(effectKey) ?? empty
      const shown = options.effect(variables)
      const exclusive = !!options.exclusive || !!shown.remove
      const predecessors = ids.map((id) => effects()[id]).filter((effect): effect is OwnedEffect => effect?.context === context)
      if (predecessors.some((effect) => effect.exclusive) || exclusive && predecessors.length) {
        const busy = new Error(m.resource_change_busy())
        options.onError?.(busy)
        throw busy
      }
      let release!: () => void
      const effect: OwnedEffect = { ...shown, context, exclusive, settled: new Promise((resolve) => { release = () => resolve(undefined) }) }
      const current = () => getStreamContext() === context && ids.every((id) => effects()[id] === effect)
      const clear = () => {
        if (!current()) return
        qc.setQueryData(effectKey, (old: Record<string, OwnedEffect> = empty) => {
          return Object.fromEntries(Object.entries(old).filter(([key]) => !ids.includes(key)))
        })
      }
      qc.setQueryData(effectKey, { ...effects(), ...Object.fromEntries(ids.map((id) => [id, effect])) })
      let outcome: 'confirmed' | 'refused' | 'unknown' = 'unknown'
      try {
        // A replaced write still reaches the server first, so the newest request lands last.
        await Promise.all(predecessors.map((effect) => effect.settled))
        if (!current()) throw new Error(m.resource_change_busy())
        const result = await options.mutationFn(variables)
        if (!current()) return result
        if (result && typeof result === 'object') {
          if ('error' in result && typeof result.error === 'string' && result.error) throw new Error(result.error)
          if ('ok' in result && result.ok === false) throw new Error(m.error_generic())
        }
        outcome = 'confirmed'
        options.onSuccess?.(result, variables)
        return result
      } catch (error) {
        if (outcome === 'unknown' && isDefiniteRefusal(error)) outcome = 'refused'
        if (current()) options.onError?.(error)
        throw error
      } finally {
        release()
        if (outcome === 'refused') {
          clear()
          // The refusal may mean this snapshot is out of date (a task changed since it was read); refresh it behind the rollback.
          void reconcileSnapshot(qc, () => getStreamContext() === context, id, options.queryKey, options.readKeys?.(variables)).catch(() => undefined)
        } else if (current()) {
          // The shown result stays until a read taken after the write confirms or replaces it.
          try { await reconcile(qc, current, id, options.queryKey, options.readKeys?.(variables)); clear() } catch {
            // An unknown outcome is never retried as another write; the next successful read settles it.
            settleOnNextRead(qc, current, clear, options.queryKey, options.readKeys?.(variables))
          }
        }
      }
    },
  })
}
