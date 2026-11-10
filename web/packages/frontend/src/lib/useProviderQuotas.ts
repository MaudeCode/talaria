import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import * as api from '../api/endpoints'
import { keys } from '../api/queryKeys'
import { useResourceEffects, useResourceMutation } from '../features/sessions/useResourceMutation'
import { showErrorToast } from '../features/toast/errorToast'
import { getStreamContext } from '../stream/connection'
import { reconcileProviderQuotas } from './providerQuotas'

type Quotas = Awaited<ReturnType<typeof api.fetchProviderQuotas>>
const SIDEBAR_PINS = 'sidebar-quota-pins'

/** TAL-1870: pin the sidebar's quota sources; the shared owner shows the choice at once and settles on the reread (`useSetDefaultModel`'s sibling). */
export function useSetSidebarQuotaPins() {
  const qc = useQueryClient()
  return useResourceMutation({
    resource: () => SIDEBAR_PINS,
    queryKey: [], readKeys: () => [keys.settings, keys.providerQuotas],
    effect: (ids: string[]) => ({ value: ids }),
    mutationFn: async (ids) => {
      const context = getStreamContext()
      const saved = await api.saveSettings({ sidebar_quota_sources: ids })
      // The owner drops a replaced write's response; keep the server's projection so a later refusal reveals it without a read.
      const { sidebar_source_ids, sidebar_can_pin } = saved
      if (sidebar_source_ids && context === getStreamContext()) qc.setQueryData<Quotas>(keys.providerQuotas, (q) => q && { ...q, sidebar_source_ids, sidebar_can_pin })
      return saved
    },
    onError: showErrorToast,
  })
}

/** The pins the user just chose, until the server's reread confirms them. */
export function useSidebarQuotaPinChoice() {
  return useResourceEffects<string[]>()[SIDEBAR_PINS]?.value
}

/** The server's pins and whether another fits, showing a pending choice until the reread confirms it. */
export function useSidebarQuotaPins(quotas: Quotas | undefined) {
  const choice = useSidebarQuotaPinChoice()
  return { ids: choice ?? quotas?.sidebar_source_ids ?? [], canPin: choice ? choice.length < 2 : quotas?.sidebar_can_pin !== false }
}

/**
 * The provider quota list every surface reads (Settings › Providers, Insights, the sidebar's pinned rows): one cache entry, one minute of
 * freshness, and a forced refresh that also rereads the OpenRouter cost history. The server recomputes pace on
 * every read (provider calls are cached 45 s), so a reset replaces an expired pace within a minute. `provider` (TAL-2151,
 * the composer chip) reads the same list with that provider's `composer` quota, one entry per provider under the same key.
 */
export function useProviderQuotas({ enabled = true, provider }: { enabled?: UseQueryOptions<Quotas, Error, Quotas, readonly string[]>['enabled']; provider?: string | undefined } = {}) {
  const qc = useQueryClient()
  const queryKey: readonly string[] = provider ? [...keys.providerQuotas, provider] : keys.providerQuotas
  const read = (refresh: boolean) => (provider ? api.fetchProviderQuotas(refresh, provider) : api.fetchProviderQuotas(refresh))
  const fetchQuotas = async (refresh = false) => reconcileProviderQuotas(qc.getQueryData(queryKey), await read(refresh))
  const quotas = useQuery({ queryKey, queryFn: () => fetchQuotas(), staleTime: 60_000, refetchInterval: 60_000, enabled })
  const refresh = () => qc.cancelQueries({ queryKey, exact: true })
    .then(() => qc.query({ queryKey, queryFn: () => fetchQuotas(true), staleTime: 0 }))
    .then(() => { void qc.invalidateQueries({ queryKey: keys.providerCostHistory }) })
    .catch(() => undefined)
  return { quotas, refresh }
}
