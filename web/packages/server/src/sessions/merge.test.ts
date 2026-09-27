import { describe, expect, it } from 'vitest'
import { toolOutcome, withToolCallOutcomes } from './merge.js'

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
    ], [{ tid: 'c1', duration: 2 }], null)
    expect((assistant as { tool_calls: unknown[] }).tool_calls).toEqual([expect.objectContaining({ tool_call_id: 'c1', done: true, is_error: true, duration: 2, result: '{"exit_code": 1}' })])
  })
})
