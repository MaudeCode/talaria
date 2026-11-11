import { afterEach, expect, it, vi } from 'vitest'
import type { SidecarLike } from '../sidecar/client.js'
import { KanbanService } from './kanban.js'

afterEach(() => { vi.useRealTimers() })

it('backs an idle board poll off to 5 s after five empty pages and returns to 1 s on an event', async () => {
  vi.useFakeTimers()
  const reads: number[] = []
  let next: number | null = null
  const sidecar = { call: (_method: string, params: { since: number }) => {
    reads.push(Date.now())
    const events = next === null ? [] : [{ id: next, task_id: 't_1', run_id: null, kind: 'created', payload: null, created_at: 1 }]
    next = null
    return Promise.resolve({ events, cursor: events[0]?.id ?? params.since, latest_event_id: 0, read_only: false })
  } } as unknown as SidecarLike
  const kanban = new KanbanService({ sidecar: () => sidecar, config: {} as never, settings: {} as never })
  const sub = kanban.subscribe('/home', null, 0)
  await vi.advanceTimersByTimeAsync(15_000)
  next = 9
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await sub.next(0, new AbortController().signal)).toMatchObject({ cursor: 9, events: [{ id: 9 }] })
  await vi.advanceTimersByTimeAsync(1_000)
  sub.close()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(reads.slice(1).map((t, i) => t - reads[i]!)).toEqual([1_000, 1_000, 1_000, 1_000, 2_000, 4_000, 5_000, 5_000, 1_000])
})

it('keeps a stream replaying history from holding back a stream already at the head', async () => {
  vi.useFakeTimers()
  // Every page below the head is a full 200-event replay page; the head has one new event.
  const sidecar = { call: (_method: string, params: { since: number }) => {
    const ids = params.since < 1_000 ? Array.from({ length: 200 }, (_, i) => params.since + i + 1) : [1_001]
    return Promise.resolve({ events: ids.map((id) => ({ id, task_id: 't_1', run_id: null, kind: 'created', payload: null, created_at: 1 })), cursor: ids.at(-1), latest_event_id: 1_001, read_only: false })
  } } as unknown as SidecarLike
  const kanban = new KanbanService({ sidecar: () => sidecar, config: {} as never, settings: {} as never })
  const live = kanban.subscribe('/home', null, 1_000)
  const replay = kanban.subscribe('/home', null, 0)
  await vi.advanceTimersByTimeAsync(0)
  const signal = new AbortController().signal
  expect(await live.next(0, signal)).toMatchObject({ cursor: 1_001, events: [{ id: 1_001 }] })
  expect(await replay.next(0, signal)).toMatchObject({ cursor: 200 })
  live.close()
  replay.close()
})
