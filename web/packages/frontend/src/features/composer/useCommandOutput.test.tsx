import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import * as api from '../../api/endpoints'
import { useCommandOutput } from './useCommandOutput'
import { teardownAll } from '../../stream/connection'

vi.mock('../../api/endpoints', () => ({ execCommand: vi.fn() }))

it('cancels on replacement, dismissal, session/profile/server switch and unmount without replay', async () => {
  const calls: { signal: AbortSignal | undefined; finish: (result: { output: string }) => void }[] = []
  vi.mocked(api.execCommand).mockImplementation((_command, _sid, signal?: AbortSignal) => new Promise((finish) => { calls.push({ signal, finish }) }))
  const client = new QueryClient()
  const hook = renderHook(({ sid }) => useCommandOutput(sid), { initialProps: { sid: 'one' }, wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
  let first!: Promise<void>
  await act(async () => { first = hook.result.current.run('/first'); await Promise.resolve() })
  expect(calls[0]?.signal?.aborted).toBe(false)
  let second!: Promise<void>
  await act(async () => { second = hook.result.current.run('/second'); await Promise.resolve() })
  expect(calls[0]?.signal?.aborted).toBe(true)
  act(() => { hook.result.current.notice?.onDismiss?.() })
  expect(calls[1]?.signal?.aborted).toBe(true)
  let third!: Promise<void>
  await act(async () => { third = hook.result.current.run('/third'); await Promise.resolve() })
  hook.rerender({ sid: 'two' })
  expect(calls[2]?.signal?.aborted).toBe(true)
  let fourth!: Promise<void>
  await act(async () => { fourth = hook.result.current.run('/fourth'); await Promise.resolve() })
  act(() => { teardownAll() })
  expect(calls[3]?.signal?.aborted).toBe(true)
  let fifth!: Promise<void>
  await act(async () => { fifth = hook.result.current.run('/fifth'); await Promise.resolve() })
  hook.unmount()
  expect(calls[4]?.signal?.aborted).toBe(true)
  await act(async () => { for (const call of calls) call.finish({ output: 'late' }); await Promise.all([first, second, third, fourth, fifth]) })
  expect(api.execCommand).toHaveBeenCalledTimes(5)
})
