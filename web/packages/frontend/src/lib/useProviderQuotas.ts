import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import * as api from '../api/endpoints'
import { keys } from '../api/queryKeys'
import { isDefiniteRefusal } from '../contracts/common'
import { reconcileProviderQuotas } from './providerQuotas'

type Quotas = Awaited<ReturnType<typeof api.fetchProviderQuotas>>
type PinProjection = Pick<Quotas, 'sidebar_source_ids' | 'sidebar_can_pin'>
interface PinWrites { latest: number; pending: number; confirmed: PinProjection; choice: PinProjection }
// One per client, not per picker: a write outlives the Settings section that started it.
const pinWrites = new WeakMap<QueryClient, PinWrites>()
function pinOwner(qc: QueryClient): PinWrites {
  let owner = pinWrites.get(qc)
  if (!owner) { owner = { latest: 0, pending: 0, confirmed: {}, choice: {} }; pinWrites.set(qc, owner) }
  return owner
}
const projection = (q: Quotas | undefined): PinProjection => ({ sidebar_source_ids: q?.sidebar_source_ids, sidebar_can_pin: q?.sidebar_can_pin })

/**
 * TAL-1870: pin the sidebar's quota sources as an optimistic update with rollback over the server's projection. A choice
 * shows at once, a read during a pending write keeps showing it, and every choice settles on the next read. A definite
 * refusal of the latest choice restores the last confirmed projection, which pending choices never overwrite.
 */
export async function setSidebarQuotaPins(qc: QueryClient, ids: string[], save: (onSaved: () => void, onError: (e: unknown) => void) => Promise<void>): Promise<void> {
  const owner = pinOwner(qc)
  const show = (shown: PinProjection) => { qc.setQueryData<Quotas>(keys.providerQuotas, (q) => q && { ...q, ...shown }) }
  await qc.cancelQueries({ queryKey: keys.providerQuotas })
  const write = ++owner.latest
  if (owner.pending++ === 0) owner.confirmed = projection(qc.getQueryData<Quotas>(keys.providerQuotas))
  const choice = { sidebar_source_ids: ids, sidebar_can_pin: ids.length < 2 }
  owner.choice = choice
  show(choice)
  await save(() => { owner.confirmed = choice }, (e) => { if (isDefiniteRefusal(e) && write === owner.latest) show(owner.confirmed) })
  owner.pending--
  if (owner.pending === 0) void qc.invalidateQueries({ queryKey: keys.providerQuotas })
}

/**
 * The provider quota list every surface reads (Settings › Providers, Insights, the sidebar's pinned rows): one cache entry, one minute of
 * freshness, and a forced refresh that also rereads the OpenRouter cost history. The server recomputes pace on
 * every read (provider calls are cached 45 s), so a reset replaces an expired pace within a minute.
 */
export function useProviderQuotas({ enabled = true }: { enabled?: boolean } = {}) {
  const qc = useQueryClient()
  const fetchQuotas = async (refresh = false) => {
    const read = reconcileProviderQuotas(qc.getQueryData(keys.providerQuotas), await api.fetchProviderQuotas(refresh))
    const owner = pinOwner(qc)
    if (owner.pending === 0) return read
    owner.confirmed = projection(read)
    return { ...read, ...owner.choice }
  }
  const quotas = useQuery({ queryKey: keys.providerQuotas, queryFn: () => fetchQuotas(), staleTime: 60_000, refetchInterval: 60_000, enabled })
  const refresh = () => qc.cancelQueries({ queryKey: keys.providerQuotas })
    .then(() => qc.query({ queryKey: keys.providerQuotas, queryFn: () => fetchQuotas(true), staleTime: 0 }))
    .then(() => { void qc.invalidateQueries({ queryKey: keys.providerCostHistory }) })
    .catch(() => undefined)
  return { quotas, refresh }
}
