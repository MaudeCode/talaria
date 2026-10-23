import { expect, it } from 'vitest'
import { SessionEventBus } from './events.js'

it('retains bounded playback instructions when invalidations coalesce across sessions and profiles', async () => {
  const bus = new SessionEventBus()
  const sub = bus.subscribe()
  for (let i = 0; i < 40; i++) bus.publish('web_completion', { profile: `profile-${i}`, sessionId: `session-${i}`, webAudio: { identity: `run-${i}`, scope: `scope-${i}`, profile: `profile-${i}`, eligible: true, expires_at: 1000 } })
  bus.publish('rename', { profile: 'other', sessionId: 'other' })
  const event = await sub.next()
  expect(event?.web_audio).toHaveLength(32)
  expect(event?.web_audio?.map((item) => item.identity)).toEqual(Array.from({ length: 32 }, (_, i) => `run-${i + 8}`))
  expect(event?.session_id).toBeUndefined()
  sub.close()
  const reconnected = bus.subscribe()
  expect(await reconnected.next(AbortSignal.timeout(5))).toBeNull()
  reconnected.close()
})
