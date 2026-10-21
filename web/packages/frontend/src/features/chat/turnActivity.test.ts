import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialStreamState, streamReducer } from '../../stream/reducer'
import type { ChatEvent } from '../../contracts/sse'
import { liveActivity } from './turnActivity'
import * as text from './render/text'

afterEach(() => { vi.restoreAllMocks() })

function liveRun() {
  let state = streamReducer(initialStreamState, { type: 'start', sessionId: 's', streamId: 'run', turnId: 'turn', userMessageId: 'u', userText: '', now: 0 })
  let seq = 0
  return {
    emit(event: ChatEvent) {
      state = streamReducer(state, { type: 'event', sessionId: 's', streamId: 'run', event, lastEventId: `run:${++seq}`, now: seq })
      return state.turns.s!
    },
    get turn() { return state.turns.s! },
  }
}

describe('live activity text processing', () => {
  it('processes each sealed segment once across 50 token appends to a 200-segment turn', () => {
    const run = liveRun()
    for (let i = 0; i < 199; i++) run.emit({ event: 'interim_assistant', data: { text: `Segment ${i}<tool_call>hidden</tool_call>` } })
    run.emit({ event: 'token', data: { text: 'Tail' } })
    expect(run.turn.segments).toHaveLength(200)
    const strip = vi.spyOn(text, 'stripToolCallXml')
    liveActivity(run.turn)
    for (let i = 0; i < 50; i++) {
      const activity = liveActivity(run.emit({ event: 'token', data: { text: '.' } }))
      expect(activity.items).toHaveLength(200)
      expect(activity.items[0]).toEqual({ key: 'text:0', kind: 'text', text: 'Segment 0' })
      expect(activity.items.at(-1)).toEqual({ key: 'text:199', kind: 'text', text: `Tail${'.'.repeat(i + 1)}` })
    }
    expect(strip).toHaveBeenCalledTimes(250)
    for (let i = 0; i < 199; i++) {
      expect(strip.mock.calls.filter(([raw]) => raw === `Segment ${i}<tool_call>hidden</tool_call>`)).toHaveLength(1)
    }
  })

  it('keeps cached content current and rekeys it when a consumed steer shifts segment positions', () => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: '<think>Plan</think>Answer<tool_call>hidden</tool_call>' } })
    liveActivity(run.turn)
    run.emit({ event: 'reasoning', data: { text: 'Check<tool_call>hidden</tool_call>', titles: ['First'] } })
    liveActivity(run.turn)
    run.emit({ event: 'reasoning', data: { text: ' more', titles: ['Second'] } })
    run.emit({ event: 'token', data: { text: 'Next' } })
    const before = liveActivity(run.turn)
    const strip = vi.spyOn(text, 'stripToolCallXml')
    const after = liveActivity(run.emit({ event: 'steer_consumed', data: { steer_id: 'hint', text: 'Focus', after_tool_call_id: null } }))
    expect(after.items).toEqual([
      { key: 'steering:hint', kind: 'steering', text: 'Focus', consumed: true },
      { key: 'text:1:thinking', kind: 'reasoning', text: 'Plan' },
      { key: 'text:1', kind: 'text', text: 'Answer' },
      { key: 'reasoning:2', kind: 'reasoning', text: 'Check more', titles: ['Second'] },
      { key: 'text:3', kind: 'text', text: 'Next' },
    ])
    expect(before.items[0]?.key).toBe('text:0:thinking')
    expect(strip.mock.calls).toEqual([['Next']])
  })
})
