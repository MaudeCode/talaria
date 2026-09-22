import { describe, expect, it } from 'vitest'
import { parseChatEvent, RELAY_CLOSE_EVENTS } from './sse'

describe('parseChatEvent', () => {
  it('parses every authoritative wire name into the union', () => {
    for (const [name, data] of [
      ['token', { text: 'hi' }], ['reasoning', { text: '', titles: ['a'] }], ['tool', { name: 'read_file', args: { path: 'x' } }],
      ['tool_complete', { name: 'read_file', is_error: false, duration: 0.2 }], ['approval', { approval_id: 'a1', command: 'rm -rf' }],
      ['clarify', { clarify_id: 'c1', question: 'Which?', choices: ['a', 'b'] }], ['done', { session: {}, usage: { input_tokens: 1 } }],
      ['stream_end', { session_id: 's' }], ['apperror', { type: 'chat_admission_timeout', message: 'busy' }], ['cancel', {}],
      ['metering', { tps: 12.5 }], ['context_status', { state: 'ok' }], ['title', { title: 'T' }], ['todo_state', { todos: [] }],
      ['steer_consumed', { steer_id: 'x', text: 'go' }], ['compressed', { new_session_id: 'n' }],
    ] as const) {
      const parsed = parseChatEvent(name, JSON.stringify(data))
      expect(parsed?.event).toBe(name)
    }
  })
  it('drops unknown event names and malformed JSON', () => {
    expect(parseChatEvent('nope', '{}')).toBeNull()
    expect(parseChatEvent('token', '{not json')).toBeNull()
    expect(parseChatEvent('token', '"a string"')).toBeNull()
  })
  it('treats an empty data frame as an empty object', () => {
    expect(parseChatEvent('cancel', '')?.event).toBe('cancel')
  })
  it('knows the relay close set', () => {
    expect([...RELAY_CLOSE_EVENTS].sort()).toEqual(['apperror', 'cancel', 'error', 'stream_end'])
  })
})
