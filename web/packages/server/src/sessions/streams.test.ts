import { expect, it } from 'vitest'
import { SessionChannels, nextSessionItem } from './streams.js'

it('coalesces ten identical session updates for a stalled subscriber', async () => {
  const channels = new SessionChannels()
  const sub = channels.subscribe('chat')
  for (let i = 0; i < 10; i++) expect(channels.emit('chat', 'session-updated', { session_id: 'chat' })).toBe(1)
  expect(sub.queue).toHaveLength(1)
  expect(await nextSessionItem(sub, 100)).toEqual(['session-updated', { session_id: 'chat' }])
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
  expect(sub.queue.at(-1)).toEqual(['session-updated', { session_id: 'chat', message_count: 99 }])
  channels.unsubscribe('chat', sub)
})
