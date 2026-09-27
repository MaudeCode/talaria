import { describe, expect, it } from 'vitest'
import { extractToolCallsFromMessages, toolOutcome, withToolCallOutcomes } from './merge.js'

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
