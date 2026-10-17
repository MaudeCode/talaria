import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../test/fixtures'
import { keys } from '../api/queryKeys'
import { teardownAll } from '../stream/connection'
import { useSaveSettings, useSettingsQuery } from './queries'
import * as api from '../api/endpoints'

vi.mock('../api/endpoints', () => ({ fetchSettings: vi.fn(), saveSettings: vi.fn() }))
const initial = { bot_name: 'Hermes', send_key: 'enter', sidebar_density: 'compact', sound_enabled: false, agent_version: 'fixture', password_enabled: true }
type Settings = Awaited<ReturnType<typeof api.fetchSettings>>

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(keys.settings, initial)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const hook = renderHook(() => ({ settings: useSettingsQuery(), save: useSaveSettings() }), { wrapper })
  const reader = renderHook(() => useSettingsQuery(), { wrapper })
  return { qc, ...hook, reader }
}

beforeEach(() => {
  vi.resetAllMocks()
  teardownAll()
  vi.mocked(api.fetchSettings).mockResolvedValue(initial)
})

describe('shared pending settings', () => {
  it('shows requested fields to every reader while the confirmed cache stays unchanged', async () => {
    const held = deferred<Settings>()
    vi.mocked(api.saveSettings).mockReturnValue(held.promise)
    const { result, qc, reader } = setup()
    act(() => result.current.save.mutate({ send_key: 'ctrl+enter', sound_enabled: true }))
    await waitFor(() => expect(reader.result.current.data?.send_key).toBe('ctrl+enter'))
    expect(reader.result.current.data?.sound_enabled).toBe(true)
    expect(qc.getQueryData(keys.settings)).toEqual(initial)
    held.resolve({ ...initial, send_key: 'ctrl+enter', sound_enabled: true })
    await waitFor(() => expect(result.current.save.isPending).toBe(false))
  })

  it('merges disjoint edits and fences stale full responses while accepting server normalization', async () => {
    const first = deferred<Settings>(), second = deferred<Settings>()
    vi.mocked(api.saveSettings).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result } = setup()
    act(() => result.current.save.mutate({ send_key: 'ctrl+enter' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1))
    act(() => result.current.save.mutate({ sidebar_density: 'detailed' }))
    await waitFor(() => expect(result.current.settings.data).toMatchObject({ send_key: 'ctrl+enter', sidebar_density: 'detailed' }))
    second.resolve({ ...initial, sidebar_density: 'detailed', agent_version: 'new' })
    await waitFor(() => expect(result.current.settings.data?.agent_version).toBe('new'))
    vi.mocked(api.fetchSettings).mockResolvedValue({ ...initial, send_key: 'normalized', sidebar_density: 'detailed', agent_version: 'new' })
    first.resolve({ bot_name: 'Hermes', send_key: 'normalized', sidebar_density: 'compact', agent_version: 'old' })
    await waitFor(() => expect(result.current.settings.data?.send_key).toBe('normalized'))
    expect(result.current.settings.data).toMatchObject({ sidebar_density: 'detailed', agent_version: 'new', password_enabled: true })
  })

  it.each(['success', 'failure'] as const)('an older %s cannot clear the latest same-key intent', async (outcome) => {
    const first = deferred<Settings>(), second = deferred<Settings>()
    vi.mocked(api.saveSettings).mockImplementationOnce(() => first.promise.then((data) => { if (outcome === 'failure') throw new Error('older failed'); return data })).mockReturnValueOnce(second.promise)
    const { result } = setup()
    act(() => result.current.save.mutate({ send_key: 'older' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1))
    act(() => result.current.save.mutate({ send_key: 'latest' }))
    await waitFor(() => expect(result.current.settings.data?.send_key).toBe('latest'))
    expect(api.saveSettings).toHaveBeenCalledTimes(1)
    first.resolve({ ...initial, send_key: 'older' })
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(2))
    expect(result.current.settings.data?.send_key).toBe('latest')
    vi.mocked(api.fetchSettings).mockResolvedValue({ ...initial, send_key: 'latest' })
    second.resolve({ ...initial, send_key: 'latest' })
    await waitFor(() => expect(result.current.save.isPending).toBe(false))
    expect(result.current.settings.data?.send_key).toBe('latest')
  })

  it('restores confirmed values and reports a refused write', async () => {
    const held = deferred<Settings>()
    vi.mocked(api.saveSettings).mockImplementation(() => held.promise.then(() => { throw new Error('refused') }))
    const { result } = setup()
    act(() => result.current.save.mutate({ sound_enabled: true }))
    await waitFor(() => expect(result.current.settings.data?.sound_enabled).toBe(true))
    held.resolve(initial)
    await waitFor(() => expect(result.current.save.error?.message).toBe('refused'))
    expect(result.current.settings.data?.sound_enabled).toBe(false)
  })

  it('restores the last accepted same-key value when the newer edit fails', async () => {
    const first = deferred<Settings>(), second = deferred<Settings>()
    vi.mocked(api.saveSettings).mockReturnValueOnce(first.promise).mockImplementationOnce(() => second.promise.then(() => { throw new Error('latest refused') }))
    const { result } = setup()
    act(() => result.current.save.mutate({ send_key: 'accepted' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1))
    act(() => result.current.save.mutate({ send_key: 'refused' }))
    await waitFor(() => expect(result.current.settings.data?.send_key).toBe('refused'))
    first.resolve({ ...initial, send_key: 'accepted' })
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(2))
    expect(result.current.settings.data?.send_key).toBe('refused')
    vi.mocked(api.fetchSettings).mockResolvedValue({ ...initial, send_key: 'accepted' })
    second.resolve(initial)
    await waitFor(() => expect(result.current.save.error?.message).toBe('latest refused'))
    expect(result.current.settings.data?.send_key).toBe('accepted')
  })

  it('retains pending ownership after the writer unmounts and isolates other query clients', async () => {
    const held = deferred<Settings>()
    vi.mocked(api.saveSettings).mockReturnValue(held.promise)
    const writer = setup(), other = setup()
    act(() => writer.result.current.save.mutate({ sound_enabled: true }))
    await waitFor(() => expect(writer.reader.result.current.data?.sound_enabled).toBe(true))
    writer.unmount()
    expect(other.reader.result.current.data?.sound_enabled).toBe(false)
    vi.mocked(api.fetchSettings).mockResolvedValue({ ...initial, sound_enabled: true })
    held.resolve({ ...initial, sound_enabled: true })
    await waitFor(() => expect(writer.qc.getQueryData(keys.settings)).toMatchObject({ sound_enabled: true }))
    expect(other.qc.getQueryData(keys.settings)).toEqual(initial)
  })

  it('an older failure preserves a newer disjoint success and its derived fields', async () => {
    const first = deferred<Settings>(), second = deferred<Settings>()
    vi.mocked(api.saveSettings).mockImplementationOnce(() => first.promise.then(() => { throw new Error('older failed') })).mockReturnValueOnce(second.promise)
    const { result, reader } = setup()
    act(() => result.current.save.mutate({ sound_enabled: true }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1))
    act(() => result.current.save.mutate({ sidebar_density: 'detailed' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(2))
    const confirmed = { ...initial, sidebar_density: 'detailed', agent_version: 'new' }
    second.resolve(confirmed)
    await waitFor(() => expect(reader.result.current.data?.agent_version).toBe('new'))
    vi.mocked(api.fetchSettings).mockResolvedValue(confirmed)
    first.resolve(initial)
    await waitFor(() => expect(reader.result.current.data?.sound_enabled).toBe(false))
    expect(reader.result.current.data).toMatchObject(confirmed)
  })

  it('does not send queued edits to a replacement profile', async () => {
    const first = deferred<Settings>()
    vi.mocked(api.saveSettings).mockReturnValue(first.promise)
    const { result, qc } = setup()
    act(() => result.current.save.mutate({ send_key: 'first' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1))
    act(() => result.current.save.mutate({ send_key: 'queued' }))
    await waitFor(() => expect(result.current.settings.data?.send_key).toBe('queued'))
    act(() => { teardownAll(); qc.clear(); qc.setQueryData(keys.settings, initial) })
    first.resolve(initial)
    await waitFor(() => expect(result.current.save.isPending).toBe(false))
    expect(api.saveSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps security and update controls confirmed while ordinary preferences are pending', async () => {
    vi.mocked(api.saveSettings).mockReturnValue(deferred<Settings>().promise)
    const { result } = setup()
    act(() => result.current.save.mutate({ sound_enabled: true, password_enabled: false, confirm_external_links: false, auto_update: true }))
    await waitFor(() => expect(result.current.settings.data?.sound_enabled).toBe(true))
    expect(result.current.settings.data?.password_enabled).toBe(true)
    expect(result.current.settings.data?.confirm_external_links).toBeUndefined()
    expect(result.current.settings.data?.auto_update).toBeUndefined()
  })

  it.each(['context', 'cache'] as const)('ignores completions after a %s reset', async (reset) => {
    const held = deferred<Settings>()
    vi.mocked(api.saveSettings).mockReturnValue(held.promise)
    const { result, qc, rerender } = setup()
    act(() => result.current.save.mutate({ send_key: 'ctrl+enter' }))
    await waitFor(() => expect(result.current.settings.data?.send_key).toBe('ctrl+enter'))
    act(() => {
      if (reset === 'context') teardownAll()
      else qc.clear()
      qc.setQueryData(keys.settings, { ...initial, bot_name: 'Other profile' })
    })
    rerender()
    await waitFor(() => expect(result.current.settings.data?.send_key).toBe('enter'))
    held.resolve({ ...initial, send_key: 'ctrl+enter' })
    await waitFor(() => expect(result.current.save.isPending).toBe(false))
    expect(qc.getQueryData(keys.settings)).toMatchObject({ bot_name: 'Other profile', send_key: 'enter' })
    expect(api.fetchSettings).not.toHaveBeenCalled()
  })
})
