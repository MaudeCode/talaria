import { describe, expect, it } from 'vitest'
import { SessionSchema } from '../../contracts/session'
import { projectMessages } from './useTranscript'
import { toolCardsFor } from './MessageRow'

/** The shape the Python server persists: integer message ids, OpenAI-style tool calls, JSON tool results. */
const persisted = {
  session_id: '8950a2bb404c',
  title: 'Real shape',
  messages: [
    { role: 'user', content: 'list the theme dir', timestamp: 1787791500, id: 7 },
    { role: 'assistant', content: 'Sure.', reasoning: 'Run ls.', finish_reason: 'tool_calls', id: 8,
      tool_calls: [{ id: 'call_a', call_id: 'call_a', response_item_id: 'fc_a', type: 'function', function: { name: 'terminal', arguments: '{"command":"ls src/theme"}' } }] },
    { role: 'tool', name: 'terminal', tool_name: 'terminal', content: '{"output": "boot.ts\\ncomponents"}', tool_call_id: 'call_a', timestamp: 1787791524.7, _db_persisted: true, id: 9 },
    { role: 'assistant', content: 'Done.', id: 10, _turnDuration: 3.2 },
  ],
}

describe('persisted session shape', () => {
  it('parses integer ids and OpenAI-shaped tool calls', () => {
    const s = SessionSchema.parse(persisted)
    const rows = projectMessages(s.messages ?? [])
    expect(rows.map((r) => r.key)).toEqual(['7', '8', '10'])
    const cards = toolCardsFor(rows[1]!.message, rows[1]!.toolResults)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.name).toBe('terminal')
    expect(cards[0]!.args).toEqual({ command: 'ls src/theme' })
    expect(cards[0]!.result).toContain('boot.ts')
  })
})
