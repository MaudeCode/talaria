import { describe, expect, it } from 'vitest'
import { firstUnreadKey } from './transcript-row.js'

type Row = Record<string, unknown>

describe('firstUnreadKey (TAL-2676)', () => {
  const rows: Row[] = [
    { role: 'user', content: 'a', message_id: 'u1' },
    { role: 'assistant', content: 'b', _background_silent: true },
    { role: 'tool', content: 'c', tool_call_id: 't1' },
    { role: 'assistant', content: 'd' },
  ]
  it('skips rows the transcript does not render, starts at the top after an empty view, and names none for a vanished row', () => {
    expect(firstUnreadKey(rows, 'u1')).toBe('3-assistant')
    expect(firstUnreadKey(rows, null)).toBe('u1')
    expect(firstUnreadKey(rows, '3-assistant')).toBeNull()
    expect(firstUnreadKey(rows, 'gone')).toBeNull()
  })
})
