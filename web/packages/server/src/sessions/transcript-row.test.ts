import { describe, expect, it } from 'vitest'
import { unreadAfter, viewedRow } from './transcript-row.js'

describe('unreadAfter (TAL-2676)', () => {
  // A detail page starting at absolute row 10, as the projection ships it.
  const page = [
    { role: 'user', content: 'a', message_id: 'u1', timestamp: 1, _display: 'row' },
    { role: 'user', content: 'steer', _steer: true, timestamp: 2, _display: 'in_scene' },
    { role: 'tool', content: 'c', tool_call_id: 't1', timestamp: 3, _display: 'in_scene' },
    { role: 'assistant', content: 'd', timestamp: 4, _display: 'row' },
  ]
  it('names the first standalone row after the viewed one, skipping steers and tool rows', () => {
    expect(unreadAfter(page, 10, { message_id: 'u1', timestamp: 1 })).toBe('13-assistant')
    expect(unreadAfter(page, 10, viewedRow(page, 10))).toBeNull()
  })
  it('starts at the top after a view of an empty chat, only on a page that reaches the top', () => {
    expect(unreadAfter(page, 0, { message_id: null, timestamp: null })).toBe('u1')
    expect(unreadAfter(page, 10, { message_id: null, timestamp: null })).toBeUndefined()
  })
  it('does not reach a row the page lacks, or one replaced at the same position', () => {
    expect(unreadAfter(page, 10, { message_id: 'gone', timestamp: 1 })).toBeUndefined()
    expect(unreadAfter(page, 10, { message_id: '13-assistant', timestamp: 99 })).toBeUndefined()
  })
})
