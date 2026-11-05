import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import * as api from '../api/endpoints'
import { keys } from '../api/queryKeys'
import { setSidebarQuotaPins, useProviderQuotas } from './useProviderQuotas'

vi.mock('../api/endpoints', () => ({ fetchProviderQuotas: vi.fn() }))

const read = (ids: string[]) => ({ version: 1, computed_at: 'now', scope_id: 's', profile_id: 'p', active_provider: null, requested_source_id: null, missing_source: false, sources: [], sidebar_source_ids: ids, sidebar_can_pin: ids.length < 2 })

describe('sidebar quota pins (TAL-1870)', () => {
  it('a read during a pending write keeps the choice, and the write settles on the next read', async () => {
    const qc = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    vi.mocked(api.fetchProviderQuotas).mockResolvedValue(read(['a']))
    const { result } = renderHook(() => useProviderQuotas(), { wrapper })
    await waitFor(() => { expect(result.current.quotas.data?.sidebar_source_ids).toEqual(['a']) })

    let saved!: () => void
    const write = setSidebarQuotaPins(qc, ['a', 'b'], (onSaved) => new Promise((resolve) => { saved = () => { onSaved(); resolve() } }))
    await waitFor(() => { expect(result.current.quotas.data?.sidebar_source_ids).toEqual(['a', 'b']) })

    await qc.refetchQueries({ queryKey: keys.providerQuotas })
    expect(qc.getQueryData(keys.providerQuotas)).toMatchObject({ sidebar_source_ids: ['a', 'b'] })

    vi.mocked(api.fetchProviderQuotas).mockResolvedValue(read(['b', 'a']))
    saved()
    await write
    await waitFor(() => { expect(result.current.quotas.data?.sidebar_source_ids).toEqual(['b', 'a']) })
  })
})
