import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { teardownAll } from '../../stream/connection'
import { keys } from '../../api/queryKeys'
import { useResourceIntents, useResourceMutation } from './useResourceMutation'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return { qc, wrapper }
}

describe('resource intent ownership', () => {
  it('keeps independent requests pending, fences stale list reads, and releases only the rejected intent', async () => {
    const a = deferred<{ ok: boolean }>(), b = deferred<{ ok: boolean }>(), old = deferred<string>()
    const { qc, wrapper } = harness()
    const read = vi.fn().mockResolvedValueOnce('baseline').mockImplementationOnce(() => old.promise).mockResolvedValue('fresh')
    const { result } = renderHook(() => {
      const list = useQuery({ queryKey: keys.sessions.list({}), queryFn: read })
      const intents = useResourceIntents()
      const write = useResourceMutation({ resource: (id: string) => `session:${id}`, intent: () => ({ label: 'Rename', title: 'Submitted' }), mutationFn: (id) => id === 'a' ? a.promise : b.promise })
      return { list, intents, write }
    }, { wrapper })
    await waitFor(() => expect(result.current.list.data).toBe('baseline'))
    let stale!: Promise<void>, first!: Promise<unknown>, second!: Promise<unknown>
    act(() => { stale = qc.invalidateQueries({ queryKey: keys.sessions.all }); first = result.current.write.mutateAsync('a').catch((e: unknown) => e); second = result.current.write.mutateAsync('b') })
    await waitFor(() => expect(Object.keys(result.current.intents)).toHaveLength(2))
    await act(async () => { a.reject(new Error('refused')); await first })
    await waitFor(() => expect(result.current.intents['session:a']).toBeUndefined())
    expect(result.current.intents['session:b']?.title).toBe('Submitted')
    await act(async () => { old.resolve('stale'); await stale })
    expect(result.current.list.data).toBe('fresh')
    await act(async () => { b.resolve({ ok: true }); await second })
    await waitFor(() => expect(result.current.intents).toEqual({}))
  })

  it('cannot apply an old profile completion or clear a replacement intent for the same ID', async () => {
    const old = deferred<{ ok: boolean }>(), replacement = deferred<{ ok: boolean }>()
    const { qc, wrapper } = harness()
    const accepted = vi.fn()
    let next = old
    const { result } = renderHook(() => ({
      intents: useResourceIntents(),
      write: useResourceMutation({ resource: () => 'session:same-id', intent: () => ({ label: 'Pin' }), mutationFn: () => next.promise, onSuccess: accepted }),
    }), { wrapper })
    let first!: Promise<unknown>, second!: Promise<unknown>
    act(() => { first = result.current.write.mutateAsync() })
    await waitFor(() => expect(result.current.intents['session:same-id']).toBeDefined())
    act(() => { teardownAll(); qc.clear(); next = replacement; second = result.current.write.mutateAsync() })
    await waitFor(() => expect(result.current.intents['session:same-id']).toBeDefined())
    await act(async () => { old.resolve({ ok: true }); await first })
    expect(accepted).not.toHaveBeenCalled()
    expect(result.current.intents['session:same-id']).toBeDefined()
    await act(async () => { replacement.resolve({ ok: true }); await second })
    expect(accepted).toHaveBeenCalledOnce()
    await waitFor(() => expect(result.current.intents).toEqual({}))
  })

  it('keeps an uncertain create locked until a successful read, without issuing another create', async () => {
    const { wrapper } = harness()
    const write = vi.fn().mockRejectedValue(new Error('connection lost'))
    const read = vi.fn().mockResolvedValueOnce('baseline').mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => ({
      projects: useQuery({ queryKey: keys.projects, queryFn: read }),
      intents: useResourceIntents(),
      create: useResourceMutation({ resource: () => 'project:new', intent: () => ({ title: 'New', label: 'Create' }), mutationFn: write }),
    }), { wrapper })
    await waitFor(() => expect(result.current.projects.data).toBe('baseline'))
    await act(async () => { await result.current.create.mutateAsync().catch(() => undefined) })
    await waitFor(() => expect(result.current.intents['project:new']?.recover).toBeDefined())
    await act(async () => { await result.current.create.mutateAsync().catch(() => undefined) })
    expect(write).toHaveBeenCalledOnce()
    read.mockResolvedValue('reconciled')
    await act(async () => { await result.current.intents['project:new']?.recover?.() })
    await waitFor(() => expect(result.current.intents).toEqual({}))
    expect(result.current.projects.data).toBe('reconciled')
  })
})
