import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANCEL_UNWIND_CEILING_S, SessionChannels, StreamChannel, StreamRegistry, nextSessionItem } from './streams.js'

afterEach(() => { vi.useRealTimers() })

it('keeps more than 32 fresh subscribes from evicting a retained frame', () => {
  const channels = new SessionChannels()
  const first = channels.subscribe('chat')
  channels.emit('chat', 'bg_task_complete', { session_id: 'chat' })
  channels.unsubscribe('chat', first)
  for (let i = 0; i < 40; i++) channels.unsubscribe('chat', channels.subscribe('chat'))
  const resumed = channels.subscribe('chat', undefined, first.initialCursor)
  expect(resumed.queue.map(([event]) => event)).toEqual(['bg_task_complete'])
  channels.unsubscribe('chat', resumed)
})

it('holds a channel for the reconnect grace after its last subscriber, then starts a new incarnation', () => {
  vi.useFakeTimers()
  const channels = new SessionChannels()
  const first = channels.subscribe('chat')
  const held = first.initialCursor
  channels.unsubscribe('chat', first)
  vi.advanceTimersByTime(59_000)
  channels.emit('chat', 'bg_task_complete', { session_id: 'chat' })
  const resumed = channels.subscribe('chat', undefined, held)
  expect(resumed.queue.map(([event]) => event)).toEqual(['bg_task_complete'])
  channels.unsubscribe('chat', resumed)
  vi.advanceTimersByTime(60_000)
  expect(channels.emit('chat', 'bg_task_complete', { session_id: 'chat' })).toBe(0)
  const fresh = channels.subscribe('chat', undefined, held)
  expect(fresh.queue).toEqual([])
  expect(fresh.initialCursor).not.toBe(held)
  channels.unsubscribe('chat', fresh)
})

it('a reconnect in one profile cannot read another profile\'s channel', () => {
  const channels = new SessionChannels()
  const work = channels.subscribe('chat', 'work')
  channels.emit('chat', 'bg_task_complete', { session_id: 'chat' }, 'work')
  const other = channels.subscribe('chat', 'default', work.initialCursor)
  expect(other.queue).toEqual([])
  channels.unsubscribe('chat', work)
  channels.unsubscribe('chat', other)
})

it('coalesces ten identical session updates for a stalled subscriber', async () => {
  const channels = new SessionChannels()
  const sub = channels.subscribe('chat')
  for (let i = 0; i < 10; i++) expect(channels.emit('chat', 'session-updated', { session_id: 'chat' })).toBe(1)
  expect(sub.queue).toHaveLength(1)
  expect((await nextSessionItem(sub, 100))?.slice(0, 2)).toEqual(['session-updated', { session_id: 'chat' }])
  channels.unsubscribe('chat', sub)
})

it('preserves distinct payloads, intervening events, profile isolation and the queue bound', () => {
  const channels = new SessionChannels()
  const sub = channels.subscribe('chat')
  const emit = (count: number) => channels.emit('chat', 'session-updated', { session_id: 'chat', message_count: count })
  emit(1)
  emit(2)
  channels.emit('chat', 'process_complete', { session_id: 'chat' })
  emit(2)
  expect(sub.queue.map(([event]) => event)).toEqual(['session-updated', 'session-updated', 'process_complete', 'session-updated'])
  channels.emit('chat', 'session-updated', { session_id: 'chat' }, 'other-profile')
  expect(sub.queue).toHaveLength(4)
  for (let i = 3; i < 100; i++) emit(i)
  expect(sub.queue).toHaveLength(64)
  expect(sub.queue.at(-1)?.slice(0, 2)).toEqual(['session-updated', { session_id: 'chat', message_count: 99 }])
  channels.unsubscribe('chat', sub)
})

describe('ephemeral MCP progress snapshots', () => {
  it('broadcasts a cleared progress value without retaining it for the next attach', () => {
    const channel = new StreamChannel()
    const [live] = channel.subscribeWithSnapshot()
    channel.put(['tool_progress', { id: 'a', progress: { percent: 42, message: 'obsolete' } }, null])
    channel.put(['tool_progress', { id: 'a', progress: null }, null])
    expect(live.queue.at(-1)?.[1]).toEqual({ id: 'a', progress: null })
    const [reloaded] = channel.subscribeWithSnapshot()
    expect(reloaded.queue).toEqual([])
  })

  it('keeps only the latest update and drops it on completion and every terminal event', () => {
    for (const event of ['tool_complete', 'done', 'cancel', 'apperror', 'error', 'stream_end']) {
      const channel = new StreamChannel()
      channel.put(['tool', { id: 'a' }, 'run:1'])
      channel.put(['tool_progress', { id: 'a', progress: { percent: 10, message: 'old' } }, null])
      channel.put(['tool_progress', { id: 'a', progress: { percent: 42, message: 'latest' } }, null])
      const [first] = channel.subscribeWithSnapshot()
      expect(first.queue.map((row) => row[0])).toEqual(['tool', 'tool_progress'])
      expect(first.queue[1]?.[1]).toMatchObject({ progress: { percent: 42 } })
      channel.unsubscribe(first)
      channel.put([event, { id: 'a' }, 'run:2'])
      const [next] = channel.subscribeWithSnapshot()
      expect(next.queue.some((row) => row[0] === 'tool_progress')).toBe(false)
    }
  })
})

it('a run that has been cancelling past the unwind ceiling with no live channel no longer blocks the session', () => {
  const registry = new StreamRegistry()
  registry.registerActiveRun({ stream_id: 'stuck-run', session_id: 'stuck-session', phase: 'cancelling', cancelled_at: 1_000, started_at: 900 } as never)
  expect(registry.activeRunStreamForSession('stuck-session', 1_000 + 60)).toBe('stuck-run')
  expect(registry.activeRunStreamForSession('stuck-session', 1_000 + CANCEL_UNWIND_CEILING_S)).toBeNull()
})
