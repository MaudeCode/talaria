import { describe, expect, it } from 'vitest'
import { BODY_EXCERPT_LIMIT, extractToolCallsFromMessages, toolOutcome, withBodyExcerpts, withToolCallOutcomes } from './merge.js'

describe('toolOutcome (TAL-313)', () => {
  it('fails a result that reports an error, a non-zero exit code, or success false, in any persisted shape', () => {
    const failed: unknown[] = [
      { exit_code: 2, output: 'x' }, '{"exitCode": 1}', '{"error": "boom"}', { error: { code: 'E' } }, { error: true }, '{"success": false}',
      [{ type: 'text', text: '{"exit_code": 127}' }],
    ]
    for (const raw of failed) expect(toolOutcome(raw).is_error, JSON.stringify(raw)).toBe(true)
    const succeeded: unknown[] = [
      { exit_code: 0, output: 'ok' }, '{"exit_code": 0, "error": ""}', '{"error": null, "success": true}', { exit_code: '2' }, 'exit_code: 2 error: boom',
      '["error"]', '', undefined, null, { error: {} }, { error: [] }, { error: false },
    ]
    for (const raw of succeeded) expect(toolOutcome(raw).is_error, JSON.stringify(raw)).toBe(false)
  })

  it('reports the result snippet', () => {
    expect(toolOutcome('plain').result_text).toBe('plain')
    expect(toolOutcome({ output: 'x' }).result_text).toBe('{"output":"x"}')
    expect(toolOutcome([{ type: 'text', text: 'part' }]).result_text).toBe('part')
    expect(toolOutcome('a'.repeat(4001)).result_text).toBe(`${'a'.repeat(4000)}...`)
    expect(toolOutcome(undefined).result_text).toBe('')
  })
})

describe('withToolCallOutcomes (TAL-313)', () => {
  it('resolves a call identified only by tool_call_id', () => {
    const [assistant] = withToolCallOutcomes([
      { role: 'assistant', content: '', tool_calls: [{ tool_call_id: 'c1', function: { name: 'terminal', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"exit_code": 1}' },
    ], [{ tid: 'c1', assistant_msg_idx: 0, duration: 2 }], null)
    expect((assistant as { tool_calls: unknown[] }).tool_calls).toEqual([expect.objectContaining({ tool_call_id: 'c1', done: true, is_error: true, duration: 2, result: '{"exit_code": 1}' })])
  })

  it('pairs a reused id with the latest earlier call, so each call keeps its own outcome', () => {
    const call = (id: string) => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'terminal', arguments: '{}' } }] })
    const rows = withToolCallOutcomes([
      { role: 'user', content: 'one' }, call('call_1'), { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'user', content: 'two' }, call('call_1'), { role: 'tool', tool_call_id: 'call_1', content: '{"exit_code": 3}' },
    ], [{ tid: 'call_1', assistant_msg_idx: 1, duration: 1 }, { tid: 'call_1', assistant_msg_idx: 4, duration: 5 }], null) as { tool_calls?: Record<string, unknown>[] }[]
    expect([rows[1], rows[4]].map((m) => { const c = m?.tool_calls?.[0]; return [c?.result, c?.is_error, c?.duration] })).toEqual([['ok', false, 1], ['{"exit_code": 3}', true, 5]])
  })

  it('keeps each turn\'s own duration when a later turn reuses an id', () => {
    const call = (id: string) => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'terminal', arguments: '{}' } }] })
    const messages = [call('call_1'), { role: 'tool', tool_call_id: 'call_1', content: 'a' }, call('call_1'), { role: 'tool', tool_call_id: 'call_1', content: 'b' }]
    const settled = extractToolCallsFromMessages(messages, [{ name: 'terminal', tid: 'call_1', duration: 9 }], [{ tid: 'call_1', assistant_msg_idx: 0, duration: 1 }])
    expect(settled.map((c) => [c.assistant_msg_idx, c.duration])).toEqual([[0, 1], [2, 9]])
  })

  it('keeps every live duration when one turn repeats an id', () => {
    const call = (id: string) => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'terminal', arguments: '{}' } }] })
    const messages = [call('call_1'), { role: 'tool', tool_call_id: 'call_1', content: 'a' }, call('call_1'), { role: 'tool', tool_call_id: 'call_1', content: 'b' }]
    const settled = extractToolCallsFromMessages(messages, [{ name: 'terminal', tid: 'call_1', duration: 1 }, { name: 'terminal', tid: 'call_1', duration: 2 }])
    expect(settled.map((c) => [c.assistant_msg_idx, c.duration])).toEqual([[0, 1], [2, 2]])
  })
})

describe('withBodyExcerpts (TAL-456)', () => {
  const excerptOf = (content: unknown, role = 'user'): Record<string, unknown> => withBodyExcerpts([{ role, content }], null)[0] as Record<string, unknown>

  it('leaves a body at the limit alone and collapses one character more', () => {
    expect(BODY_EXCERPT_LIMIT).toBe(3000)
    expect(excerptOf('a'.repeat(3000))).not.toHaveProperty('_display_truncated')
    expect(excerptOf('a'.repeat(3000))).not.toHaveProperty('_display_excerpt')
    const over = excerptOf('a'.repeat(3001))
    expect(over._display_truncated).toBe(true)
    expect(over._display_excerpt).toBe('a'.repeat(3000))
    expect(over.content).toBe('a'.repeat(3001))
  })

  it('cuts at the last line break, else the last space, in the second half of the limit', () => {
    expect(excerptOf(`${'x'.repeat(2000)}\n${'y'.repeat(800)} ${'z'.repeat(800)}`)._display_excerpt).toBe('x'.repeat(2000))
    expect(excerptOf(`${'x'.repeat(2500)} ${'y'.repeat(800)}`)._display_excerpt).toBe('x'.repeat(2500))
    // A break that early would leave a stub, so the cut falls on the limit instead.
    expect(excerptOf(`${'x'.repeat(10)}\n${'y'.repeat(5000)}`)._display_excerpt).toBe(`${'x'.repeat(10)}\n${'y'.repeat(2989)}`)
  })

  it('never splits a grapheme cluster at the limit', () => {
    const family = '👨‍👩‍👧'
    const excerpt = String(excerptOf(`${'a'.repeat(2998)}${family}${'b'.repeat(100)}`)._display_excerpt)
    expect(excerpt).toBe('a'.repeat(2998))
  })

  it('reads text parts, covers assistant rows, and skips other roles', () => {
    expect(excerptOf([{ type: 'text', text: 'p'.repeat(3500) }], 'assistant')._display_excerpt).toBe('p'.repeat(3000))
    expect(excerptOf('t'.repeat(5000), 'tool')).not.toHaveProperty('_display_truncated')
  })

  it('stamps a long scene final answer and leaves a short one alone', () => {
    const scene = (final: string) => ({ version: 'activity_scene_v1', activity_rows: [], final_answer: final })
    const [long, short] = withBodyExcerpts([{ role: 'assistant', content: 'x', _anchor_activity_scene: scene('f'.repeat(3200)) }, { role: 'assistant', content: 'y', _anchor_activity_scene: scene('ok') }], null) as unknown as Record<string, Record<string, unknown>>[]
    expect(long?._anchor_activity_scene?.final_answer_excerpt).toBe('f'.repeat(3000))
    expect(long?._anchor_activity_scene?.final_answer).toBe('f'.repeat(3200))
    expect(long).not.toHaveProperty('_display_truncated')
    expect(short?._anchor_activity_scene).not.toHaveProperty('final_answer_excerpt')
  })

  it('leaves the running turn alone and returns copies', () => {
    const rows = [{ role: 'user', content: 'u'.repeat(4000), _turn_id: 'run' }, { role: 'assistant', content: 'a'.repeat(4000), _turn_id: 'done' }]
    const out = withBodyExcerpts(rows, 'run') as Record<string, unknown>[]
    expect(out[0]).toBe(rows[0])
    expect(out[1]?._display_truncated).toBe(true)
    expect(rows[1]).not.toHaveProperty('_display_truncated')
  })
})
