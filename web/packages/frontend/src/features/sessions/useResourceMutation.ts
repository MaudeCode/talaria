import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { getStreamContext } from '../../stream/connection'
import { keys } from '../../api/queryKeys'
import * as api from '../../api/endpoints'
import { m } from '../../paraglide/messages.js'

/** Local presentation only. Never merge these fields into cached server snapshots. */
export interface ResourceIntent {
  label: string
  title?: string
  color?: string
  recover?: () => Promise<void>
}
interface OwnedIntent extends ResourceIntent { context: object }
const intentKey = ['resource-intents'] as const
const empty: Record<string, OwnedIntent> = {}

export function useResourceIntents(): Record<string, ResourceIntent> {
  const { data } = useQuery({ queryKey: intentKey, queryFn: () => empty, initialData: empty, enabled: false, gcTime: Infinity, structuralSharing: false })
  return Object.fromEntries(Object.entries(data).filter(([, intent]) => intent.context === getStreamContext()))
}

async function reconcile(qc: QueryClient, current: () => boolean, resource: string) {
  if (!current()) return
  // Cancel reads captured before the write, including inactive detail/search queries.
  await Promise.all([keys.sessions.all, keys.projects].map((queryKey) => qc.cancelQueries({ queryKey })))
  if (!current()) return
  const projects = qc.getQueryCache().find({ queryKey: keys.projects, exact: true })
  await Promise.all([
    qc.invalidateQueries({ queryKey: keys.sessions.all }, { throwOnError: true }),
    typeof projects?.options.queryFn === 'function'
      ? qc.invalidateQueries({ queryKey: keys.projects, refetchType: 'all' }, { throwOnError: true })
      : resource.startsWith('project:') ? qc.query({ queryKey: keys.projects, queryFn: api.fetchProjects, staleTime: 0 }) : Promise.resolve(),
  ])
}

/** One owner per resource across sidebar, menus and detail. Independent resources can proceed. */
export function useResourceMutation<V, R>(options: {
  resource: (variables: V) => string
  intent: (variables: V) => ResourceIntent
  mutationFn: (variables: V) => Promise<R>
  onSuccess?: (result: R) => void
  onError?: (error: unknown) => void
}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (variables: V) => {
      qc.setQueryDefaults(intentKey, { structuralSharing: false })
      const id = options.resource(variables)
      const context = getStreamContext()
      const intents = () => qc.getQueryData<Record<string, OwnedIntent>>(intentKey) ?? empty
      if (intents()[id]?.context === context) throw new Error(m.resource_change_busy())
      const intent: OwnedIntent = { ...options.intent(variables), context }
      const current = () => getStreamContext() === context && intents()[id] === intent
      const clear = () => {
        if (!current()) return
        qc.setQueryData(intentKey, (old: Record<string, OwnedIntent> = empty) => {
          return Object.fromEntries(Object.entries(old).filter(([key]) => key !== id))
        })
      }
      qc.setQueryData(intentKey, { ...intents(), [id]: intent })
      try {
        const result = await options.mutationFn(variables)
        if (!current()) return result
        if (result && typeof result === 'object') {
          if ('error' in result && typeof result.error === 'string' && result.error) throw new Error(result.error)
          if ('ok' in result && result.ok === false) throw new Error(m.error_generic())
        }
        // Success callbacks consume the confirmed write, while the overlay remains until fresh reads finish.
        options.onSuccess?.(result)
        return result
      } catch (error) {
        if (current()) options.onError?.(error)
        throw error
      } finally {
        if (current()) {
          const recover = async () => { await reconcile(qc, current, id); clear() }
          try { await recover() } catch {
            // An unknown outcome cannot be retried as another create/delete. Retry reads only.
            if (current()) {
              const uncertain = { ...intent, recover }
              // Keep ownership by token even when the display acquires its retry action.
              Object.assign(intent, uncertain)
              qc.setQueryData(intentKey, { ...intents() })
            }
          }
        }
      }
    },
  })
}
