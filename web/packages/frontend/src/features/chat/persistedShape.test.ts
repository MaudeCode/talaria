import canonicalScene from './__fixtures__/activity-scene.json'
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

// TAL-233: presentation grouping retains the raw index used by branch/edit actions.
describe('assistant turn projection', () => {
  it('groups a multi-step turn once while preserving the final raw message index', async () => {
    const { groupAssistantTurns, persistedActivity } = await import('./turnActivity')
    const messages = [...persisted.messages.slice(0, 3),
      { role: 'assistant', id: 11, content: 'Checking another file.', tool_calls: [{ id: 'call_b', name: 'read_file', args: { path: 'b' } }] },
      { role: 'tool', id: 12, tool_call_id: 'call_b', content: 'b contents' },
      persisted.messages[3]!,
      { role: 'user', id: 13, content: 'Again' },
      { role: 'assistant', id: 14, content: 'Done again.' },
    ]
    const rows = groupAssistantTurns(projectMessages(SessionSchema.parse({ ...persisted, messages }).messages!, 120))
    expect(rows.map((r) => r.message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(rows[1]!.index).toBe(125)
    expect(persistedActivity(rows[1]!).items.map((i) => i.kind)).toEqual(['reasoning', 'text', 'tool', 'text', 'tool'])
    expect(persistedActivity(rows[1]!).finalAnswer).toBe('Done.')
    expect(groupAssistantTurns(projectMessages(messages.slice(1), 121))[0]!.index).toBe(125)
  })

  it('keeps explicit different owners and adjacent completed replies separate', async () => {
    const { groupAssistantTurns } = await import('./turnActivity')
    const rows = projectMessages([
      { role: 'assistant', id: 'a', content: 'First', _anchor_stream_id: 'one', tool_calls: [{ id: 'x' }] },
      { role: 'assistant', id: 'b', content: 'Second', _anchor_stream_id: 'two' },
      { role: 'assistant', id: 'c', content: 'Third' },
    ])
    expect(groupAssistantTurns(rows)).toHaveLength(3)
  })

  it('uses recovered scene order and stable tool ids without duplicating its final answer', async () => {
    const { groupAssistantTurns, persistedActivity } = await import('./turnActivity')
    const rows = groupAssistantTurns(projectMessages([{ role: 'assistant', id: 4, content: 'Answer', _anchor_stream_id: 'run', _anchor_activity_scene: {
      version: 'activity_scene_v1', activity_rows: [
        { row_id: 'p', role: 'prose', text: 'Progress' },
        { row_id: 'a', role: 'tool', tool_call_id: 'a', tool: { name: 'read_file', done: false } },
        { row_id: 'a-replayed', role: 'tool', tool_call_id: 'a', tool: { name: 'read_file', snippet: 'contents', done: true } },
        { row_id: 'b', role: 'tool', tool_call_id: 'b', tool: { name: 'read_file', done: true } },
        { row_id: 'answer', role: 'prose', text: 'Answer' },
      ],
    } }]))
    const activity = persistedActivity(rows[0]!)
    expect(activity.items.map((item) => item.key)).toEqual(['p', 'tool:a', 'tool:b'])
    expect(activity.items[1]).toMatchObject({ kind: 'tool', call: { done: true, result: 'contents' } })
    expect(activity.finalAnswer).toBe('Answer')
  })
})


describe('persisted terminal outcomes', () => {
  it.each(['Cancellation details', 'Interruption details', 'Provider details'])('retains partial work before %s without reporting Worked', async (label) => {
    const { groupAssistantTurns, persistedActivity } = await import('./turnActivity')
    const grouped = groupAssistantTurns(projectMessages([
      { role: 'user', id: 1, content: 'Inspect' },
      { role: 'assistant', id: 2, content: 'Partial output', _partial: true, tool_calls: [{ id: 'a', name: 'read_file' }] },
      { role: 'assistant', id: 3, content: 'Terminal explanation', _error: true, provider_details_label: label },
    ]))
    expect(grouped).toHaveLength(2)
    expect(persistedActivity(grouped[1]!).status).toBe(label === 'Cancellation details' ? 'cancelled' : label === 'Interruption details' ? 'interrupted' : 'error')
    expect(persistedActivity(grouped[1]!).items.map((item) => item.kind)).toEqual(['text', 'tool'])
  })
})


// Exact payload from App's testSessionDecodesActivitySceneInOrder; only the required Web title is added.
describe('canonical cross-client activity scene', () => {
  it('orders the unsorted persisted rows before separating the final answer', async () => {
    const { groupAssistantTurns, persistedActivity } = await import('./turnActivity')
    const session = SessionSchema.parse(canonicalScene.session)
    const row = groupAssistantTurns(projectMessages(session.messages ?? []))[0]!
    const activity = persistedActivity(row)
    expect(activity.items.map((item) => item.key)).toEqual(['prose-1', 'thinking-1', 'tool:call-1'])
    expect(activity.finalAnswer).toBe('After tool.')
  })

  it('decodes the nested thinking text and titles', async () => {
    const { sceneItems } = await import('./turnActivity')
    const items = sceneItems(canonicalScene.session.messages[0]!._anchor_activity_scene.activity_rows)
    expect(items.find((item) => item.kind === 'reasoning')).toMatchObject({ text: 'I should inspect now.', titles: ['Planning implementation'] })
  })

  it('uses stable source-index fallbacks and retains legacy top-level reasoning', async () => {
    const { sceneItems } = await import('./turnActivity')
    const items = sceneItems([
      { row_id: 'a', order_index: 2, role: 'prose', text: 'A' },
      { row_id: 'b', role: 'thinking', text: 'Legacy reasoning', titles: ['Legacy title'] },
      { row_id: 'c', order_index: 2, role: 'prose', text: 'C' },
      { row_id: 'd', order_index: 'invalid', role: 'prose', text: 'D' },
    ])
    expect(items.map((item) => item.key)).toEqual(['b', 'a', 'c', 'd'])
    expect(items[0]).toMatchObject({ text: 'Legacy reasoning', titles: ['Legacy title'] })
  })
})
