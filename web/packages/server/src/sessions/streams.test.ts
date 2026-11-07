import { afterEach, expect, it, vi } from 'vitest'
import { SessionChannels, nextSessionItem } from './streams.js'

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
