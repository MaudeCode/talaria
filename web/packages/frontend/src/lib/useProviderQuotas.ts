import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '../api/endpoints'
import { keys } from '../api/queryKeys'
import { reconcileProviderQuotas } from './providerQuotas'

/**
 * The provider quota list every surface reads (Settings › Providers, Insights, the sidebar's pinned rows): one cache entry, one minute of
 * freshness, and a forced refresh that also rereads the OpenRouter cost history. The server recomputes pace on
 * every read (provider calls are cached 45 s), so a reset replaces an expired pace within a minute.
 */
export function useProviderQuotas({ enabled = true }: { enabled?: boolean } = {}) {
  const qc = useQueryClient()
  const fetchQuotas = async (refresh = false) => reconcileProviderQuotas(qc.getQueryData(keys.providerQuotas), await api.fetchProviderQuotas(refresh))
  const quotas = useQuery({ queryKey: keys.providerQuotas, queryFn: () => fetchQuotas(), staleTime: 60_000, refetchInterval: 60_000, enabled })
  const refresh = () => qc.cancelQueries({ queryKey: keys.providerQuotas })
    .then(() => qc.query({ queryKey: keys.providerQuotas, queryFn: () => fetchQuotas(true), staleTime: 0 }))
    .then(() => { void qc.invalidateQueries({ queryKey: keys.providerCostHistory }) })
    .catch(() => undefined)
  return { quotas, refresh }
}
