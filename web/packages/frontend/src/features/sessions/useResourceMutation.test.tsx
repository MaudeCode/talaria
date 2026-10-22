import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { teardownAll } from '../../stream/connection'
import { keys } from '../../api/queryKeys'
import { useResourceEffects, useResourceMutation, withEffects } from './useResourceMutation'
import { ApiError } from '../../contracts/common'

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

describe('optimistic resource ownership', () => {
  it('keeps independent requests pending, fences stale list reads, and releases only the rejected intent', async () => {
    const a = deferred<{ ok: boolean }>(), b = deferred<{ ok: boolean }>(), old = deferred<string>()
    const { qc, wrapper } = harness()
    const read = vi.fn().mockResolvedValueOnce('baseline').mockImplementationOnce(() => old.promise).mockResolvedValue('fresh')
    const { result } = renderHook(() => {
      const list = useQuery({ queryKey: keys.sessions.list({}), queryFn: read })
      const intents = useResourceEffects()
      const write = useResourceMutation({ resource: (id: string) => `session:${id}`, effect: () => ({ fields: { title: 'Submitted' } }), mutationFn: (id) => id === 'a' ? a.promise : b.promise })
      return { list, intents, write }
    }, { wrapper })
    await waitFor(() => expect(result.current.list.data).toBe('baseline'))
    let stale!: Promise<void>, first!: Promise<unknown>, second!: Promise<unknown>
    act(() => { stale = qc.invalidateQueries({ queryKey: keys.sessions.all }); first = result.current.write.mutateAsync('a').catch((e: unknown) => e); second = result.current.write.mutateAsync('b') })
    await waitFor(() => expect(Object.keys(result.current.intents)).toHaveLength(2))
    await act(async () => { a.reject(new Error('refused')); await first })
    await waitFor(() => expect(result.current.intents['session:a']).toBeUndefined())
    expect(result.current.intents['session:b']?.fields?.title).toBe('Submitted')
    await act(async () => { old.resolve('stale'); await stale })
    expect(result.current.list.data).toBe('fresh')
    await act(async () => { b.resolve({ ok: true }); await second })
    await waitFor(() => expect(result.current.intents).toEqual({}))
  })

  it('reconciles independent completions without stranding a peer intent', async () => {
    const a = deferred<{ ok: boolean }>(), b = deferred<{ ok: boolean }>(), firstRead = deferred<string>()
    const initialProjects = deferred<string>(), projectRead = deferred<string>()
    const { wrapper } = harness()
    const projects = vi.fn().mockImplementationOnce(() => initialProjects.promise).mockImplementationOnce(() => projectRead.promise).mockResolvedValue('latest projects')
    const read = vi.fn().mockResolvedValueOnce('baseline').mockImplementationOnce(() => firstRead.promise).mockResolvedValue('latest')
    const { result } = renderHook(() => ({
      list: useQuery({ queryKey: keys.sessions.list({}), queryFn: read }),
      projects: useQuery({ queryKey: keys.projects, queryFn: projects }),
      intents: useResourceEffects(),
      write: useResourceMutation({ resource: (id: string) => id, effect: () => ({ fields: { touched: true } }), mutationFn: (id) => id === 'session:a' ? a.promise : b.promise }),
    }), { wrapper })
    await waitFor(() => expect(result.current.list.data).toBe('baseline'))
    let first!: Promise<unknown>, second!: Promise<unknown>
    act(() => { first = result.current.write.mutateAsync('session:a'); second = result.current.write.mutateAsync('session:b') })
    await waitFor(() => expect(Object.keys(result.current.intents)).toHaveLength(2))
    await act(async () => { a.resolve({ ok: true }); await Promise.resolve() })
    await waitFor(() => { expect(read).toHaveBeenCalledTimes(2); expect(projects).toHaveBeenCalledTimes(2) })
    // B completes while A's reconciliation read is held, rather than while A's write is held.
    await act(async () => { b.resolve({ ok: true }); await Promise.resolve() })
    await act(async () => { firstRead.resolve('from A'); projectRead.resolve('projects from A'); initialProjects.resolve('stale projects'); await Promise.all([first, second]) })
    await waitFor(() => expect(result.current.intents).toEqual({}))
    expect(result.current.list.data).toBe('latest')
  })

  it('does not restore a confirmed deletion from a peer snapshot', async () => {
    const a = deferred<{ ok: boolean }>(), b = deferred<{ ok: boolean }>()
    const stale = deferred<string[]>(), fresh = deferred<string[]>()
    const { qc, wrapper } = harness()
    const read = vi.fn().mockResolvedValueOnce(['keeper', 'deleted']).mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => fresh.promise)
    const { result } = renderHook(() => ({
      list: useQuery({ queryKey: keys.sessions.list({}), queryFn: read }),
      intents: useResourceEffects(),
      change: useResourceMutation({ resource: () => 'session:keeper', effect: () => ({ fields: { touched: true } }), mutationFn: () => a.promise }),
      remove: useResourceMutation({ resource: () => 'session:deleted', effect: () => ({ fields: { touched: true } }), mutationFn: () => b.promise, onSuccess: () => qc.setQueryData(keys.sessions.list({}), ['keeper']) }),
    }), { wrapper })
    await waitFor(() => expect(result.current.list.data).toEqual(['keeper', 'deleted']))
    let first!: Promise<unknown>, second!: Promise<unknown>
    act(() => { first = result.current.change.mutateAsync(); second = result.current.remove.mutateAsync() })
    await act(async () => { a.resolve({ ok: true }); await Promise.resolve() })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await act(async () => { b.resolve({ ok: true }); await Promise.resolve() })
    await act(async () => { stale.resolve(['keeper', 'deleted']); await Promise.resolve() })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    try {
      expect(result.current.list.data).toEqual(['keeper'])
    } finally {
      await act(async () => { fresh.resolve(['keeper']); await Promise.all([first, second]) })
    }
    await waitFor(() => expect(result.current.intents).toEqual({}))
  })

  it('cannot apply an old profile completion or clear a replacement intent for the same ID', async () => {
    const old = deferred<{ ok: boolean }>(), replacement = deferred<{ ok: boolean }>()
    const { qc, wrapper } = harness()
    const accepted = vi.fn()
    let next = old
    const { result } = renderHook(() => ({
      intents: useResourceEffects(),
      write: useResourceMutation({ resource: () => 'session:same-id', effect: () => ({ fields: { touched: true } }), mutationFn: () => next.promise, onSuccess: accepted }),
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

  it('keeps an uncertain create shown and exclusive until a later successful read, without issuing another create', async () => {
    const { qc, wrapper } = harness()
    const write = vi.fn().mockRejectedValue(new ApiError({ kind: 'network', path: '/projects', message: 'connection lost' }))
    const read = vi.fn().mockResolvedValueOnce('baseline').mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => ({
      projects: useQuery({ queryKey: keys.projects, queryFn: read }),
      intents: useResourceEffects(),
      create: useResourceMutation({ resource: () => 'project:new', exclusive: true, effect: () => ({ fields: { name: 'New' } }), mutationFn: write }),
    }), { wrapper })
    await waitFor(() => expect(result.current.projects.data).toBe('baseline'))
    await act(async () => { await result.current.create.mutateAsync().catch(() => undefined) })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(result.current.intents['project:new']?.fields?.name).toBe('New')
    await expect(act(() => result.current.create.mutateAsync())).rejects.toThrow('Wait for the pending change to finish.')
    expect(write).toHaveBeenCalledOnce()
    read.mockResolvedValue('reconciled')
    await act(async () => { await qc.refetchQueries({ queryKey: keys.projects }) })
    await waitFor(() => expect(result.current.intents).toEqual({}))
    expect(result.current.projects.data).toBe('reconciled')
  })

  it('shows the effect at once, rolls a definite refusal back without a wait, and keeps it through an unknown outcome', async () => {
    const { wrapper } = harness()
    const refused = deferred<never>(), lost = deferred<never>(), reread = deferred<string>()
    const read = vi.fn().mockResolvedValueOnce('baseline').mockImplementation(() => reread.promise)
    const { result } = renderHook(() => ({
      list: useQuery({ queryKey: keys.sessions.list({}), queryFn: read }),
      intents: useResourceEffects(),
      write: useResourceMutation({ resource: (id: string) => `session:${id}`, effect: () => ({ fields: { title: 'Shown' } }), mutationFn: (id: string) => id === 'a' ? refused.promise : lost.promise }),
    }), { wrapper })
    await waitFor(() => expect(result.current.list.data).toBe('baseline'))
    let a!: Promise<unknown>, b!: Promise<unknown>
    act(() => { a = result.current.write.mutateAsync('a').catch((e: unknown) => e); b = result.current.write.mutateAsync('b').catch((e: unknown) => e) })
    await waitFor(() => expect(Object.keys(result.current.intents).sort()).toEqual(['session:a', 'session:b']))
    // The refusal rolls back before any read answers: the reread stays held throughout.
    await act(async () => { refused.reject(new ApiError({ kind: 'http', status: 409, path: '/x', message: 'refused' })); await a })
    await waitFor(() => expect(result.current.intents['session:a']).toBeUndefined())
    await act(async () => { lost.reject(new ApiError({ kind: 'http', status: 502, path: '/x', message: 'bad gateway' })); await Promise.resolve() })
    // The refusal's background refresh and B's reconciliation both wait on the held reread.
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    expect(result.current.intents['session:b']?.fields?.title).toBe('Shown')
    await act(async () => { reread.resolve('fresh'); await b })
    await waitFor(() => expect(result.current.intents).toEqual({}))
  })

  it('queues a repeated write behind its predecessor and shows only the newest value; an exclusive write refuses', async () => {
    const { wrapper } = harness()
    const first = deferred<{ ok: boolean }>()
    const sent: string[] = []
    const { result } = renderHook(() => ({
      intents: useResourceEffects(),
      rename: useResourceMutation({ resource: () => 'session:a', effect: (title: string) => ({ fields: { title } }), mutationFn: (title: string) => { sent.push(title); return title === 'one' ? first.promise : Promise.resolve({ ok: true }) } }),
      remove: useResourceMutation({ resource: () => 'session:a', effect: () => ({ remove: true }), mutationFn: () => Promise.resolve({ ok: true }) }),
    }), { wrapper })
    let one!: Promise<unknown>, two!: Promise<unknown>
    act(() => { one = result.current.rename.mutateAsync('one') })
    await waitFor(() => expect(sent).toEqual(['one']))
    act(() => { two = result.current.rename.mutateAsync('two') })
    await waitFor(() => expect(result.current.intents['session:a']?.fields?.title).toBe('two'))
    expect(sent).toEqual(['one'])
    await expect(act(() => result.current.remove.mutateAsync())).rejects.toThrow('Wait for the pending change to finish.')
    await act(async () => { first.resolve({ ok: true }); await Promise.all([one, two]) })
    expect(sent).toEqual(['one', 'two'])
    await waitFor(() => expect(result.current.intents).toEqual({}))
  })

  it('settles the rest of a multi-resource write after a later write replaces one of its resources', async () => {
    const { wrapper } = harness()
    const bulk = deferred<{ ok: boolean }>()
    const { result } = renderHook(() => ({
      intents: useResourceEffects(),
      write: useResourceMutation({ resource: (ids: string[]) => ids, effect: () => ({ fields: { status: 'done' } }), mutationFn: (ids: string[]) => ids.length > 1 ? bulk.promise : Promise.resolve({ ok: true }) }),
    }), { wrapper })
    let many!: Promise<unknown>, one!: Promise<unknown>
    act(() => { many = result.current.write.mutateAsync(['a', 'b']) })
    await waitFor(() => expect(Object.keys(result.current.intents).sort()).toEqual(['a', 'b']))
    act(() => { one = result.current.write.mutateAsync(['a']) })
    await act(async () => { bulk.resolve({ ok: true }); await Promise.all([many, one]) })
    await waitFor(() => expect(result.current.intents).toEqual({}))
  })

  it('after a failed reconciliation, waits for every displayed snapshot to read again before settling', async () => {
    const { qc, wrapper } = harness()
    const family = ['kanban', 'board', 'default']
    const view = vi.fn().mockResolvedValueOnce('view').mockRejectedValue(new Error('offline'))
    const stats = vi.fn().mockResolvedValueOnce('stats').mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => ({
      view: useQuery({ queryKey: [...family, 'view'], queryFn: view }),
      stats: useQuery({ queryKey: [...family, 'stats'], queryFn: stats }),
      intents: useResourceEffects(),
      write: useResourceMutation({ resource: () => 'card', queryKey: family, effect: () => ({ fields: { status: 'done' } }), mutationFn: () => Promise.reject(new ApiError({ kind: 'timeout', path: '/x', message: 'timed out' })) }),
    }), { wrapper })
    await waitFor(() => expect(result.current.stats.data).toBe('stats'))
    await act(async () => { await result.current.write.mutateAsync().catch(() => undefined) })
    await waitFor(() => expect(view).toHaveBeenCalledTimes(2))
    stats.mockResolvedValue('stats again')
    await act(async () => { await qc.refetchQueries({ queryKey: [...family, 'stats'] }) })
    expect(result.current.intents.card?.fields?.status).toBe('done')
    view.mockResolvedValue('view again')
    await act(async () => { await qc.refetchQueries({ queryKey: [...family, 'view'] }) })
    await waitFor(() => expect(result.current.intents).toEqual({}))
  })

  it('drops removed rows and patches fields for display', () => {
    const rows = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]
    expect(withEffects(rows, (r) => r.id, { a: { remove: true }, b: { fields: { title: 'Renamed' } } })).toEqual([{ id: 'b', title: 'Renamed' }, { id: 'c', title: 'C' }])
    expect(rows[1]?.title).toBe('B')
  })

  it('never ships a pending label', () => {
    const messages = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../messages/en.json'), 'utf8')) as Record<string, unknown>
    expect(messages).not.toHaveProperty('resource_change_pending')
    expect(Object.values(messages).some((text) => typeof text === 'string' && text.startsWith('Pending: '))).toBe(false)
  })

  it('leaves an unrelated in-flight history read intact during required snapshot reconciliation', async () => {
    const { wrapper } = harness()
    const history = deferred<string>()
    const { result } = renderHook(() => ({
      list: useQuery({ queryKey: keys.crons.list(false), queryFn: () => Promise.resolve('jobs') }),
      history: useQuery({ queryKey: keys.crons.history('digest'), queryFn: () => history.promise }),
      change: useResourceMutation({ resource: () => 'cron:digest', queryKey: keys.crons.all, readKeys: () => [keys.crons.list(false)], effect: () => ({ fields: { touched: true } }), mutationFn: () => Promise.resolve({ ok: true }) }),
    }), { wrapper })
    await waitFor(() => expect(result.current.list.data).toBe('jobs'))
    await act(async () => { await result.current.change.mutateAsync() })
    await act(async () => { history.resolve('selected run'); await history.promise })
    await waitFor(() => expect(result.current.history.data).toBe('selected run'))
  })

  it('coalesces required read sets while excluding an unrelated failed descendant', async () => {
    const { qc, wrapper } = harness()
    const family = ['kanban', 'board', 'default']
    const a = deferred<{ ok: boolean }>(), b = deferred<{ ok: boolean }>(), held = deferred<string>()
    const readA = vi.fn().mockResolvedValueOnce('old A').mockImplementationOnce(() => held.promise).mockResolvedValue('fresh A')
    const readB = vi.fn().mockResolvedValueOnce('old B').mockResolvedValue('fresh B')
    const irrelevant = vi.fn(() => Promise.reject(new Error('deleted task')))
    await qc.query({ queryKey: [...family, 'deleted'], queryFn: irrelevant }).catch(() => undefined)
    const { result } = renderHook(() => ({
      a: useQuery({ queryKey: [...family, 'a'], queryFn: readA }),
      b: useQuery({ queryKey: [...family, 'b'], queryFn: readB }),
      intents: useResourceEffects(),
      change: useResourceMutation({ resource: (id: string) => id, queryKey: family, readKeys: (id) => [[...family, id]], effect: () => ({ fields: { touched: true } }), mutationFn: (id) => id === 'a' ? a.promise : b.promise }),
    }), { wrapper })
    await waitFor(() => expect(result.current.b.data).toBe('old B'))
    let first!: Promise<unknown>, second!: Promise<unknown>
    act(() => { first = result.current.change.mutateAsync('a'); second = result.current.change.mutateAsync('b') })
    await act(async () => { a.resolve({ ok: true }); await Promise.resolve() })
    await waitFor(() => expect(readA).toHaveBeenCalledTimes(2))
    await act(async () => { b.resolve({ ok: true }); await Promise.resolve() })
    await act(async () => { held.resolve('from A'); await Promise.all([first, second]) })
    await waitFor(() => expect(result.current.intents).toEqual({}))
    expect(result.current.a.data).toBe('fresh A')
    expect(result.current.b.data).toBe('fresh B')
    expect(irrelevant).toHaveBeenCalledTimes(1)
  })

})
