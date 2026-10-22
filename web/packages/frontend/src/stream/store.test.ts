import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { dispatch, getStreamState, resetStreamStoreForTests, subscribe, useLiveTurn } from './store'
import { parseChatEvent } from '../contracts/sse'

let frames: FrameRequestCallback[] = []
const renderFrame = () => { const run = frames; frames = []; for (const cb of run) cb(0) }
const tick = () => { renderFrame(); vi.runOnlyPendingTimers() }

function event(sessionId: string, name: string, data: unknown, seq: number) {
  const parsed = parseChatEvent(name, JSON.stringify(data))
  if (!parsed) throw new Error(`unparseable ${name}`)
  dispatch({ type: 'event', sessionId, streamId: `${sessionId}-stream`, event: parsed, lastEventId: `${sessionId}-stream:${seq}`, now: seq })
}
const start = (sessionId: string) => dispatch({ type: 'start', sessionId, streamId: `${sessionId}-stream`, turnId: null, userMessageId: null, userText: 'hi', now: 0 })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => { frames = [] })
  resetStreamStoreForTests()
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('live-turn store notification', () => {
  it('yields publication out of the rendering callback and cancels queued publication on settlement', () => {
    start('a')
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    try {
      event('a', 'token', { text: 'first' }, 1)
      renderFrame()
      expect(listener).not.toHaveBeenCalled()
      vi.runOnlyPendingTimers()
      expect(listener).toHaveBeenCalledTimes(1)
      event('a', 'token', { text: ' last' }, 2)
      renderFrame()
      expect(listener).toHaveBeenCalledTimes(1)
      event('a', 'done', {}, 3)
      expect(listener).toHaveBeenCalledTimes(2)
      vi.runOnlyPendingTimers()
      expect(listener).toHaveBeenCalledTimes(2)
    } finally { unsubscribe() }
  })

  it('publishes pending tokens to React only at the frame boundary, including unrelated renders', () => {
    start('a')
    const { result, rerender } = renderHook(() => useLiveTurn('a'))
    act(() => event('a', 'token', { text: 'pending' }, 1))
    expect(getStreamState().turns.a!.segments).toEqual([{ kind: 'text', text: 'pending' }])
    rerender()
    expect(result.current!.segments).toEqual([])
    act(() => renderFrame())
    rerender()
    expect(result.current!.segments).toEqual([])
    act(() => vi.runOnlyPendingTimers())
    expect(result.current!.segments).toEqual([{ kind: 'text', text: 'pending' }])
    act(() => {
      event('a', 'token', { text: ' last' }, 2)
      event('a', 'done', {}, 3)
    })
    expect(result.current).toMatchObject({ status: 'done', segments: [{ kind: 'text', text: 'pending last' }] })
  })

  it('coalesces token frames into one notification per animation frame and notifies terminal frames immediately', () => {
    start('a')
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    for (let i = 1; i <= 10; i++) event('a', 'token', { text: `t${i}` }, i)
    expect(listener).not.toHaveBeenCalled()
    tick()
    expect(listener).toHaveBeenCalledTimes(1)

    event('a', 'token', { text: 'last' }, 11)
    event('a', 'done', {}, 12)
    expect(listener).toHaveBeenCalledTimes(2)
    tick()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('keeps the snapshot for one session unchanged while another session streams', () => {
    start('a')
    start('b')
    let renders = 0
    const { result } = renderHook(() => { renders++; return useLiveTurn('b') })
    const before = result.current
    const rendersBefore = renders
    act(() => { event('a', 'token', { text: 'only a' }, 1); tick() })
    expect(result.current).toBe(before)
    expect(renders).toBe(rendersBefore)
  })
})
