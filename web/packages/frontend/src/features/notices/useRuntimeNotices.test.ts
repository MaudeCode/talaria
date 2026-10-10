import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../api/endpoints', () => ({ fetchAgentHealth: vi.fn() }))
import * as api from '../../api/endpoints'
import { markServerStopped, retryDelay, STOPPED_AFTER, useServerProbe } from './useRuntimeNotices'

describe('retryDelay', () => {
  it('waits 1 s after the first failure and doubles to a 30 s cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  })
})

describe('markServerStopped', () => {
  it('keeps the server stopped when a probe sent before the stop answers afterwards', async () => {
    let answer!: (health: { alive: boolean }) => void
    vi.mocked(api.fetchAgentHealth).mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
    const { result } = renderHook(() => useServerProbe(), { wrapper })
    await waitFor(() => expect(result.current.probe.isFetching).toBe(true))

    await act(async () => { markServerStopped(qc); await Promise.resolve() })
    await act(async () => { answer({ alive: true }); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(result.current.failures).toBe(STOPPED_AFTER)
  })
})
