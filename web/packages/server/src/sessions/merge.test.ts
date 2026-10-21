import { describe, expect, it } from 'vitest'
import { BODY_EXCERPT_LIMIT, assistantReplyAddedAfterCurrentTurn, extractToolCallsFromMessages, markerKind, mergeDisplayMessagesAfterAgentResult, mergeSessionMessagesAppendOnly, normalizeAssistantDisplay, sessionLacksFinalAssistantAnswer, splitDisplayText, stripToolCallXml, toolOutcome, withBodyExcerpts, withDisplayMedia, withMarkerKinds, withToolCallOutcomes } from './merge.js'

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

  it('renders a skill_manage refusal neutrally unless its rollback failed, as Agent v0.22.3 does (TAL-1261)', () => {
    // The Agent's own retry loop; the marker counts only in the error text.
    const refusal = { success: false, error: 'Skill body exceeds the 20000 character limit.', file_preview: 'ROLLBACK FAILED is only data here' }
    expect(toolOutcome(refusal, 'skill_manage').is_error).toBe(false)
    expect(toolOutcome(JSON.stringify(refusal), 'skill_manage').is_error).toBe(false)
    expect(toolOutcome({ success: false, error: 'ROLLBACK FAILED: 2 files left changed' }, 'skill_manage').is_error).toBe(true)
    expect(toolOutcome(refusal, 'terminal').is_error).toBe(true)
    expect(toolOutcome(refusal).is_error).toBe(true)
    // Neutral beats the provider's flag, as the Agent's own renderer does.
    expect(toolOutcome(refusal, 'skill_manage', true).is_error).toBe(false)
    expect(toolOutcome('', 'terminal', true).is_error).toBe(true)
  })

  it('fails a failed status and a batch where every item errored, as Agent v0.22.3 does (TAL-1261)', () => {
    const failed: unknown[] = [
      '{"status": "failed"}', { status: 'error' }, { status: 'FAILED' },
      { results: [{ error: 'interrupted' }, { error: { message: 'interrupted' } }] },
    ]
    for (const raw of failed) expect(toolOutcome(raw, 'delegate_task').is_error, JSON.stringify(raw)).toBe(true)
    const succeeded: unknown[] = [
      { status: 'completed' }, { status: 'degraded' }, { results: [] }, { results: [{ error: 'interrupted' }, { summary: 'done' }] },
      { results: [{ error: 'interrupted' }, 'text'] }, { results: [{ error: '' }] },
    ]
    for (const raw of succeeded) expect(toolOutcome(raw, 'delegate_task').is_error, JSON.stringify(raw)).toBe(false)
  })

  it('judges every persisted and live call by its own tool name (TAL-1261)', () => {
    const refusal = JSON.stringify({ success: false, error: 'Skill body exceeds the 20000 character limit.' })
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 's1', function: { name: 'skill_manage', arguments: '{}' } }, { id: 'f1', function: { name: 'patch', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 's1', content: refusal },
      { role: 'tool', tool_call_id: 'f1', content: refusal },
    ]
    expect(extractToolCallsFromMessages(messages).map((tc) => [tc.tid, tc.is_error])).toEqual([['s1', false], ['f1', true]])
    const projected = withToolCallOutcomes(messages, [], null)[0] as { tool_calls: Record<string, unknown>[] }
    expect(projected.tool_calls.map((tc) => [tc.id, tc.is_error])).toEqual([['s1', false], ['f1', true]])
    const anthropic = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'skill_manage', input: {} }, { type: 'tool_use', id: 'f1', name: 'patch', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: refusal, is_error: true }, { type: 'tool_result', tool_use_id: 'f1', content: 'ok', is_error: true }] },
    ]
    expect(extractToolCallsFromMessages(anthropic).map((tc) => [tc.tid, tc.is_error])).toEqual([['s1', false], ['f1', true]])
    const flagged = withToolCallOutcomes(anthropic, [], null)[0] as unknown as { tool_calls: Record<string, unknown>[] }
    expect(flagged.tool_calls.map((tc) => [tc.id, tc.is_error])).toEqual([['s1', false], ['f1', true]])
  })

  it('reports the result snippet', () => {
    expect(toolOutcome('plain').result_text).toBe('plain')
    expect(toolOutcome({ output: 'x' }).result_text).toBe('{"output":"x"}')
    expect(toolOutcome([{ type: 'text', text: 'part' }]).result_text).toBe('part')
    expect(toolOutcome('a'.repeat(4001)).result_text).toBe(`${'a'.repeat(4000)}...`)
    expect(toolOutcome(undefined).result_text).toBe('')
  })

  it('reports the result view both clients render (TAL-315)', () => {
    const cases: [unknown, Record<string, unknown>][] = [
      // Terminal results: output, stderr, error, then the exit code only when it is non-zero or nothing else shows.
      ['{"output":"line one\\nline two\\n","exit_code":0,"error":null}', { stdout: 'line one\nline two' }],
      [{ output: 'a\\nb', stderr: 'warn', exit_code: 1, error: 'boom' }, { stdout: 'a\nb', stderr: 'warn', error: 'boom', exit_code: 1 }],
      [{ stdout: 'x', exitCode: '3' }, { stdout: 'x', exit_code: 3 }],
      [{ output: '', exit_code: 0 }, { exit_code: 0 }],
      ['{"output":"done\\n","exit_code":1e300,"error":null}', { stdout: 'done' }],
      [{ exit_code: 'abc', error: 'denied' }, { error: 'denied' }],
      ['{\\"output\\":\\"pwd\\n\\",\\"exit_code\\":0,\\"error\\":null}', { stdout: 'pwd' }],
      // Nested JSON strings unwrap; escaped line breaks become real ones.
      [JSON.stringify(JSON.stringify({ output: 'nested', exit_code: 0 })), { stdout: 'nested' }],
      [{ result: JSON.stringify({ stdout: 'inner', exit_code: 4 }) }, { stdout: 'inner', exit_code: 4 }],
      [{ content: 'tab\\there\\r\\nnext' }, { text: 'tab\there\nnext' }],
      // Other objects: the first readable value; an array of text parts joins; anything else is pretty JSON.
      [{ results: [{ title: 'Hermes WebUI' }], exit_code: 0, error: null }, { text: '[\n  {\n    "title": "Hermes WebUI"\n  }\n]' }],
      [{ result: '', message: 'saved' }, { text: 'saved' }],
      [{ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }, { text: 'one\ntwo' }],
      [[{ type: 'text', text: 'part' }], { text: 'part' }],
      [[{ title: 'match' }], { text: '[\n  {\n    "title": "match"\n  }\n]' }],
      [{ a: 1 }, { text: '{\n  "a": 1\n}' }],
      // Scalars and plain text; text that is not JSON stays as written.
      [42, { text: '42' }], [true, { text: 'true' }], ['true', { text: 'true' }],
      ['plain \\n text', { text: 'plain \\n text' }], ['{"output": "unterminated"', { text: '{"output": "unterminated"' }],
      ['', {}], [undefined, {}], [null, {}], [{}, {}],
    ]
    for (const [raw, view] of cases) expect(toolOutcome(raw).result_view, JSON.stringify(raw)).toEqual(view)
  })

  it('caps every result view field at the result cap (TAL-315)', () => {
    const long = 'x'.repeat(5000)
    const lengths = (raw: unknown) => Object.entries(toolOutcome(raw).result_view ?? {}).map(([key, value]) => [key, String(value).length, String(value).endsWith('x...')])
    expect(lengths({ output: long, stderr: long, error: long })).toEqual([['stdout', 4003, true], ['stderr', 4003, true], ['error', 4003, true]])
    expect(lengths(long)).toEqual([['text', 4003, true]])
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
  const excerptOf = (content: unknown, role = 'user'): Record<string, unknown> => withBodyExcerpts([{ role, content }], null, null)[0] as Record<string, unknown>

  it('leaves a body at the limit alone and collapses one character more', () => {
    expect(BODY_EXCERPT_LIMIT).toBe(3000)
    expect(excerptOf('a'.repeat(3000))).not.toHaveProperty('_display_truncated')
    expect(excerptOf('a'.repeat(3000))).not.toHaveProperty('_display_excerpt')
    const over = excerptOf('a'.repeat(3001))
    expect(over._display_truncated).toBe(true)
    expect(over._display_excerpt).toBe('a'.repeat(3000))
    expect(over.content).toBe('a'.repeat(3001))
  })

  it('keeps the newest settled reply full until a newer visible reply settles (TAL-1114)', () => {
    const answer = (id: string, content: string) => ({ role: 'assistant', content, _turn_id: id,
      _anchor_activity_scene: { version: 'activity_scene_v1', activity_rows: [], final_answer: content } })
    const a = answer('A', 'a'.repeat(6000)), older = answer('old', 'o'.repeat(5000))
    const trailing = [
      { role: 'user', content: 'next', _turn_id: 'B' },
      { role: 'assistant', content: 'interim', _interim: true, _turn_id: 'B' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call' }], _turn_id: 'B' },
      { role: 'tool', content: 'result', _turn_id: 'B' },
    ]
    for (const active of ['B', null]) {
      const result = withBodyExcerpts([older, a, ...trailing], active) as Record<string, unknown>[]
      expect(result[0]?._display_truncated).toBe(true)
      expect(result[1]).not.toHaveProperty('_display_excerpt')
      expect(result[1]?._anchor_activity_scene).not.toHaveProperty('final_answer_excerpt')
      expect(result[1]?.content).toBe(a.content)
    }
    const b = answer('B', 'new answer')
    const result = withBodyExcerpts([older, a, ...trailing, b], null) as Record<string, unknown>[]
    expect(result[1]?._display_excerpt).toBe('a'.repeat(3000))
    expect(result[1]?._anchor_activity_scene).toMatchObject({ final_answer_excerpt: 'a'.repeat(3000) })
    expect(result.at(-1)).not.toHaveProperty('_display_excerpt')
    expect(a).not.toHaveProperty('_display_excerpt')
  })

  it('clears stale excerpts without changing stored rows and ignores non-replies (TAL-1114)', () => {
    const answer = { role: 'assistant', content: 'a'.repeat(5000), _turn_id: 'A', _display_truncated: true, _display_excerpt: 'stale',
      _anchor_activity_scene: { final_answer: 'a'.repeat(5000), final_answer_excerpt: 'stale' } }
    const nonReplies = [
      { role: 'assistant', content: '<think>only reasoning</think>' },
      { role: 'assistant', content: 'hidden', display_kind: 'hidden' },
      { role: 'assistant', content: 'silent', _background_silent: true },
      { role: 'assistant', content: 'notice', display_kind: 'failed_turn' },
      { role: 'assistant', content: 'marker', _marker_kind: 'context_compaction' },
      { role: 'assistant', content: 'partial', _partial: true },
    ].map((row, i) => ({ ...row, _turn_id: `other-${i}` }))
    const result = withBodyExcerpts([answer, ...nonReplies], null) as Record<string, unknown>[]
    expect(result[0]).not.toHaveProperty('_display_excerpt')
    expect(result[0]).not.toHaveProperty('_display_truncated')
    expect(result[0]?._anchor_activity_scene).not.toHaveProperty('final_answer_excerpt')
    expect(answer._display_excerpt).toBe('stale')
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
    expect(out[0]).toEqual(rows[0])
    expect(out[1]).not.toHaveProperty('_display_truncated')
    expect(rows[1]).not.toHaveProperty('_display_truncated')
  })
})

describe('withDisplayMedia (TAL-186)', () => {
  const project = (text: string) => (text.includes('MEDIA:') ? { text: text.replaceAll('MEDIA:/tmp/a.png', '![a.png](u)'), media: [{ url: 'u', name: 'a.png', mime: 'image/png', kind: 'image' as const }] } : null)

  it('projects assistant content, the scene final answer and prose rows, and nothing else', () => {
    const scene = { version: 'activity_scene_v1', final_answer: 'Done MEDIA:/tmp/a.png', activity_rows: [{ row_id: 'p', role: 'prose', text: 'First MEDIA:/tmp/a.png' }, { row_id: 'q', role: 'prose', text: 'plain' }, { row_id: 't', role: 'tool', text: 'MEDIA:/tmp/a.png' }] }
    const rows = [{ role: 'user', content: 'MEDIA:/tmp/a.png' }, { role: 'assistant', content: 'Done MEDIA:/tmp/a.png', _anchor_activity_scene: scene }, { role: 'assistant', content: 'plain' }]
    const [user, reply, plainReply] = withDisplayMedia(rows, project) as Record<string, unknown>[]
    expect(user).toBe(rows[0])
    expect(plainReply).toBe(rows[2])
    expect(reply).toMatchObject({ content: 'Done MEDIA:/tmp/a.png', _display_content: 'Done ![a.png](u)', _media: [{ url: 'u' }] })
    const projected = reply?._anchor_activity_scene as Record<string, unknown>
    expect(projected).toMatchObject({ final_answer: 'Done MEDIA:/tmp/a.png', final_answer_display: 'Done ![a.png](u)', final_answer_media: [{ url: 'u' }] })
    const [prose, plain, tool] = projected.activity_rows as Record<string, unknown>[]
    expect(prose).toMatchObject({ text: 'First MEDIA:/tmp/a.png', display_text: 'First ![a.png](u)', media: [{ url: 'u' }] })
    expect(plain).not.toHaveProperty('display_text')
    expect(tool).not.toHaveProperty('display_text')
    expect(rows[1]).not.toHaveProperty('_display_content')
  })

  it('cuts body excerpts from the display text', () => {
    // The content fits the limit; its display text, with a long media URL, does not.
    const url = 'u'.repeat(100)
    const long = `${'w'.repeat(2900)} MEDIA:/tmp/a.png`
    const scene = { version: 'activity_scene_v1', activity_rows: [], final_answer: long }
    const longProject = (text: string) => ({ text: text.replace('MEDIA:/tmp/a.png', `![a.png](${url})`), media: [] })
    const [reply] = withBodyExcerpts(withDisplayMedia([{ role: 'assistant', content: long, _anchor_activity_scene: scene }], longProject), null, null) as Record<string, unknown>[]
    expect(reply?._display_truncated).toBe(true)
    expect(reply?._display_excerpt).toBe('w'.repeat(2900))
    expect((reply?._anchor_activity_scene as Record<string, unknown>).final_answer_excerpt).toBe('w'.repeat(2900))
  })
})

describe('mergeSessionMessagesAppendOnly truncation watermark (TAL-504)', () => {
  const msg = (role: string, content: string, timestamp: number) => ({ role, content, timestamp })
  const contents = (rows: { content?: unknown }[]) => rows.map((m) => m.content)
  const state = [msg('user', 'u1', 100), msg('assistant', 'a1', 101), msg('user', 'u2', 102), msg('assistant', 'a2', 103), msg('user', 'u3', 104), msg('assistant', 'a3', 105)]

  it('keeps the deleted tail out while the sidecar has not advanced past the watermark', () => {
    expect(contents(mergeSessionMessagesAppendOnly(state.slice(0, 2), state, { truncationWatermark: 101 }))).toEqual(['u1', 'a1'])
  })

  it('skips the state tail after a sidecar truncation (Python test_reconciled_messages_skip_state_tail_after_sidecar_truncation)', () => {
    const sidecar = [msg('user', 'first', 1), msg('assistant', 'reply first', 2)]
    const db = [...sidecar, msg('user', 'second', 3), msg('assistant', 'reply second', 4)]
    expect(contents(mergeSessionMessagesAppendOnly(sidecar, db, { truncationWatermark: 2 }))).toEqual(['first', 'reply first'])
  })

  it('filters a deleted tail above the watermark (Python test_above_watermark_deleted_tail_still_filtered_when_sidecar_not_advanced)', () => {
    const sidecar = [msg('user', 'q1', 1), msg('assistant', 'a1', 2)]
    expect(contents(mergeSessionMessagesAppendOnly(sidecar, [...sidecar, msg('assistant', 'deleted tail', 5)], { truncationWatermark: 2 }))).toEqual(['q1', 'a1'])
  })

  it('keeps only rows at or before the watermark for an empty sidecar (Python test_core_a_not_advanced_watermark_equals_boundary_does_not_resurrect)', () => {
    const db = [msg('user', 'u1', 50), msg('assistant', 'a1', 51), msg('user', 'deleted-u2', 100), msg('assistant', 'deleted-a2', 101), msg('user', 'deleted-u3', 150), msg('assistant', 'deleted-a3', 151)]
    expect(contents(mergeSessionMessagesAppendOnly([], db, { truncationWatermark: 51 }))).toEqual(['u1', 'a1'])
  })

  it('merges state rows newer than the sidecar once the sidecar has advanced past the watermark', () => {
    const sidecar = [msg('user', 'u1', 100), msg('assistant', 'a1', 101), msg('user', 'after edit', 200)]
    const db = [...state, msg('user', 'after edit', 200), msg('assistant', 'CLI reply', 201)]
    expect(contents(mergeSessionMessagesAppendOnly(sidecar, db, { truncationWatermark: 101 }))).toEqual(['u1', 'a1', 'after edit', 'CLI reply'])
  })

  it('keeps state rows newer than a compression watermark, which marks compressed rows rather than a cut', () => {
    expect(contents(mergeSessionMessagesAppendOnly(state.slice(0, 2), state, { truncationWatermark: 101, compressedWatermark: true }))).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
  })
})

describe('assistant display text (TAL-302)', () => {
  it('removes complete and cut-off tool-call XML, DSML variants included, and leaves ordinary text untouched', () => {
    expect(stripToolCallXml('Hi <function_calls><invoke name="x"/></function_calls> there')).toBe('Hi  there')
    expect(stripToolCallXml('Prose\n<function_calls><invoke')).toBe('Prose')
    expect(stripToolCallXml('<tool_call>{"a":1}</tool_call>after')).toBe('after')
    expect(stripToolCallXml('Prose <｜DSML｜function_calls><｜DSML｜invoke name="x"></｜DSML｜function_calls>')).toBe('Prose')
    expect(stripToolCallXml('plain **md** <b>x</b>\n')).toBe('plain **md** <b>x</b>\n')
    // Markup an answer writes as Markdown code is literal.
    expect(stripToolCallXml('Use `<function_calls>` and `<tool_call>` tags.')).toBe('Use `<function_calls>` and `<tool_call>` tags.')
    expect(stripToolCallXml('Example:\n```xml\n<function_calls><invoke/></function_calls>\n```\nDone <tool_call>{}</tool_call>')).toBe('Example:\n```xml\n<function_calls><invoke/></function_calls>\n```\nDone')
  })

  it('splits every inline thinking form out of the text, anywhere and unterminated', () => {
    expect(splitDisplayText('<think>plan</think>Answer')).toEqual(['Answer', 'plan'])
    expect(splitDisplayText('Intro <thinking>mid</thinking>end')).toEqual(['Intro end', 'mid'])
    expect(splitDisplayText('<|channel|>thought\nhmm<channel|>Yes')).toEqual(['Yes', 'hmm'])
    expect(splitDisplayText('<|turn|>thinking\nplan<turn|>Done')).toEqual(['Done', 'plan'])
    expect(splitDisplayText('Answer <think>still')).toEqual(['Answer', 'still'])
    expect(splitDisplayText('<think>a</think>One <think>b</think>Two')).toEqual(['One Two', 'a\n\nb'])
    expect(splitDisplayText('no tags\n')).toEqual(['no tags', ''])
    // Any case and attributes, as providers emit them.
    expect(splitDisplayText('<think type="analysis">plan</think>Answer')).toEqual(['Answer', 'plan'])
    expect(splitDisplayText('<THINK>plan</THINK>Answer')).toEqual(['Answer', 'plan'])
    expect(splitDisplayText('<|CHANNEL|>thought\nhmm<channel|>Yes')).toEqual(['Yes', 'hmm'])
    expect(splitDisplayText('<|turn|>thinking\nplan<TURN|>Done')).toEqual(['Done', 'plan'])
    expect(splitDisplayText('<think-tank>is prose')).toEqual(['<think-tank>is prose', ''])
    // A tag written as Markdown code is prose, inline or fenced, even unterminated.
    expect(splitDisplayText('Use `<think>` and `<function_calls>` tags.')).toEqual(['Use `<think>` and `<function_calls>` tags.', ''])
    expect(splitDisplayText('<think>real</think>See:\n```\n<think>\n```')).toEqual(['See:\n```\n<think>\n```', 'real'])
    expect(splitDisplayText('Open fence:\n```\n<thinking>')).toEqual(['Open fence:\n```\n<thinking>', ''])
    expect(splitDisplayText('Open fence:\n```\nline\n<thinking>')).toEqual(['Open fence:\n```\nline\n<thinking>', ''])
    // A stray backtick pairs with nothing across a paragraph break.
    expect(splitDisplayText('A ` tick.\n\n<think>plan</think>Answer `x`')).toEqual(['A ` tick.\n\nAnswer `x`', 'plan'])
  })

  it('ships clean content and one reasoning string, idempotently, and leaves other rows and the input alone', () => {
    const raw = { role: 'assistant', content: '<think>inline</think>Answer <tool_call>{}</tool_call>', reasoning_content: 'shared', reasoning: 'shared', thinking: 'extra' }
    const once = normalizeAssistantDisplay(raw)
    expect(once).toEqual({ role: 'assistant', content: 'Answer', reasoning: 'shared\n\nextra\n\ninline' })
    expect(normalizeAssistantDisplay(once)).toEqual(once)
    expect(raw.reasoning_content).toBe('shared')
    const user = { role: 'user', content: '<think>x</think>' }
    expect(normalizeAssistantDisplay(user)).toBe(user)
    expect(normalizeAssistantDisplay({ role: 'assistant', content: 'plain' })).toEqual({ role: 'assistant', content: 'plain' })
    // Text nothing was taken out of keeps its exact whitespace, in a string and in a text part.
    expect(normalizeAssistantDisplay({ role: 'assistant', content: '    indented code\n' }).content).toBe('    indented code\n')
    expect(normalizeAssistantDisplay({ role: 'assistant', content: [{ type: 'text', text: ' plain ' }] }).content).toEqual([{ type: 'text', text: ' plain ' }])
  })

  it('moves typed thinking parts and a listed reasoning field into reasoning', () => {
    expect(normalizeAssistantDisplay({ role: 'assistant', content: [{ type: 'thinking', thinking: 'typed' }, { type: 'text', text: '<think>part</think>Answer' }, { type: 'image_url', image_url: { url: 'x' } }], reasoning: [{ type: 'text', text: 'listed' }] }))
      .toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Answer' }, { type: 'image_url', image_url: { url: 'x' } }], reasoning: 'listed\n\ntyped\n\npart' })
    // A reasoning part already contained in a longer one (a settled row merged its inline thinking) shows once.
    expect(normalizeAssistantDisplay({ role: 'assistant', content: 'A', reasoning_content: 'plan', reasoning: 'plan\n\ninline' })).toEqual({ role: 'assistant', content: 'A', reasoning: 'plan\n\ninline' })
    // Text that merely occurs inside another part is still its own reasoning.
    expect(normalizeAssistantDisplay({ role: 'assistant', content: 'A', reasoning_content: 'Yes', reasoning: 'Yes, it exists.' })).toEqual({ role: 'assistant', content: 'A', reasoning: 'Yes\n\nYes, it exists.' })
  })
})

describe('compaction markers (TAL-305)', () => {
  const TASKS = '[Your active task list was preserved across context compression]'

  it('classifies both marker kinds with one rule', () => {
    const cases: [Record<string, unknown>, string | null][] = [
      [{ role: 'user', content: '[CONTEXT COMPACTION] Earlier turns were summarised.' }, 'context_compaction'],
      [{ role: 'user', content: ' \n[Context Compaction — reference only] lower' }, 'context_compaction'],
      [{ role: 'assistant', content: '[context compaction] summary' }, 'context_compaction'],
      [{ role: 'user', content: [{ type: 'text', text: '[CONTEXT COMPACTION] in parts' }] }, 'context_compaction'],
      [{ role: 'system', content: '', _compaction_marker: true }, 'context_compaction'],
      [{ role: 'user', content: 'x', _compression_marker: true }, 'context_compaction'],
      [{ role: 'user', content: 'x', _context_compression_marker: true }, 'context_compaction'],
      [{ role: 'user', content: `${TASKS}\n- [ ] ship it` }, 'preserved_task_list'],
      [{ role: 'user', content: `  ${TASKS.toUpperCase()} tasks` }, 'preserved_task_list'],
      // Prose about compaction, a tool result, and an assistant echo of the task-list line are ordinary messages.
      [{ role: 'assistant', content: 'Context compaction is how the Agent shortens history.' }, null],
      [{ role: 'user', content: 'context compaction, explain it' }, null],
      [{ role: 'tool', content: '[CONTEXT COMPACTION] output' }, null],
      [{ role: 'assistant', content: `${TASKS} tasks` }, null],
      [{ role: 'user', content: 'Hello' }, null],
    ]
    for (const [message, kind] of cases) expect(markerKind(message), JSON.stringify(message)).toBe(kind)
  })

  it('stamps the kind, and the task list without its marker line, on copies', () => {
    const rows = [
      { role: 'user', content: '[CONTEXT COMPACTION] summary' },
      { role: 'user', content: `  ${TASKS}\n- [ ] one\n- [x] two  ` },
      { role: 'assistant', content: 'Context compaction is fine.' },
    ]
    const out = withMarkerKinds(rows, {}) as Record<string, unknown>[]
    expect(out[0]).toEqual({ ...rows[0], _marker_kind: 'context_compaction' })
    expect(out[1]).toEqual({ ...rows[1], _marker_kind: 'preserved_task_list', _marker_body: '- [ ] one\n- [x] two' })
    expect(out[2]).toBe(rows[2])
    expect(rows[0]).not.toHaveProperty('_marker_kind')
  })

  it('stamps the Agent\'s failed-turn boundary as a notice once per turn and hides its scaffold rows (TAL-815)', () => {
    const partial = 'This turn did not complete. Some actions may already have run; verify their effects before resending.'
    const rows = [
      { role: 'user', content: 'web turn', _turn_id: 'web' },
      { role: 'assistant', content: '**Error:** boom', _error: true, _turn_id: 'web' },
      { role: 'assistant', content: partial, display_kind: 'failed_turn', _turn_id: 'web' },
      { role: 'user', content: 'cli turn', _turn_id: 'cli' },
      { role: 'user', content: '  [System: continue]', _turn_id: 'cli' },
      // A boundary written before the Agent typed it is recognized by its exact copy, as the Agent's own read side does.
      { role: 'assistant', content: ` ${partial} `, _turn_id: 'cli' },
      { role: 'assistant', content: `Quoting: ${partial}`, _turn_id: 'cli' },
      // A typed `[System:` row is the Agent's timeline entry, not scaffolding.
      { role: 'user', content: '[System: The active model changed.]', display_kind: 'model_switch', _turn_id: 'cli' },
      // TAL-1261: the Agent's late language-server note (`agent/turn_stop_gates.py`), untyped like `[System:`.
      { role: 'user', content: '[System note: the language server reported problems in files you edited this turn, after those tool results had returned. Fix them if they are real, then give your final answer.]\n\nsrc/a.ts: 1 error', _turn_id: 'cli' },
    ]
    const out = withMarkerKinds(rows, {}) as Record<string, unknown>[]
    // Web's own error row already reports the web turn, so the Agent's copy is hidden there.
    expect(out[2]).toEqual({ ...rows[2], display_kind: 'hidden' })
    expect(out[2]).not.toHaveProperty('_notice_kind')
    expect(out[4]).toEqual({ ...rows[4], display_kind: 'hidden' })
    expect(out[5]).toEqual({ ...rows[5], _notice_kind: 'failed_turn' })
    expect(out[8]).toEqual({ ...rows[8], display_kind: 'hidden' })
    for (const i of [0, 1, 3, 6, 7]) expect(out[i]).toBe(rows[i])
  })

  it('never counts the Agent\'s failed-turn boundary as the turn\'s answer (TAL-815)', () => {
    const boundary = { role: 'assistant', content: 'Your request was not processed. Send it again if you still want me to carry it out.', display_kind: 'failed_turn' }
    expect(assistantReplyAddedAfterCurrentTurn([{ role: 'user', content: 'go' }, boundary], [], 'go')).toBe(false)
    expect(sessionLacksFinalAssistantAnswer([{ role: 'user', content: 'go' }, boundary])).toBe(true)
    expect(assistantReplyAddedAfterCurrentTurn([{ role: 'user', content: 'go' }, { role: 'assistant', content: 'Done.' }, boundary], [], 'go')).toBe(true)
  })

  it('drops bracketed markers of either case from the settled display', () => {
    const previous = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: '[context compaction] old summary' }]
    const result = [...previous.slice(0, 2), { role: 'user', content: '[CONTEXT COMPACTION] new summary' }, { role: 'user', content: 'Next' }, { role: 'assistant', content: 'Context compaction is a summary step.' }]
    const merged = mergeDisplayMessagesAfterAgentResult(previous, previous, result, 'Next')
    expect(merged.map((m) => m.content)).toEqual(['Hi', 'Hello', 'Next', 'Context compaction is a summary step.'])
  })
})

describe('absorbed durable identity (TAL-1019)', () => {
  it.each([1, null])('keeps distinct tool results that reuse a UID with marker %s', (stateDbSeenId) => {
    const prior = { role: 'tool', content: 'old result', timestamp: 100, tool_call_id: 'call-old', _state_db_row_id: 1, _state_db_message_uid: 'reused' }
    const next = { ...prior, content: 'new result', timestamp: 200, tool_call_id: 'call-new', _state_db_row_id: 2 }
    expect(mergeSessionMessagesAppendOnly([prior], [next], { stateDbSeenId })).toEqual([prior, next])
  })

  it('does not discard a new carrier just because one absorbed constituent is already local', () => {
    const prior = { role: 'user', content: 'earlier prefix', timestamp: 100, message_uid: 'already' }
    const next = { role: 'user', content: 'new request', timestamp: 200, _state_db_row_id: 2, _state_db_message_uid: 'carrier', _absorbed_message_uids: ['already'] }
    expect(mergeSessionMessagesAppendOnly([prior], [next], { stateDbSeenId: 1 })).toEqual([prior, next])
    const extended = { ...next, _state_db_message_uid: 'already', _absorbed_message_uids: ['new-occurrence'] }
    expect(mergeSessionMessagesAppendOnly([prior], [extended], { stateDbSeenId: 1 })).toEqual([prior, extended])
  })

  it.each([42, null])('keeps absorbed numeric rows represented with seen marker %s', (stateDbSeenId) => {
    const prompt = { role: 'user', content: 'Background prefix\ncontinue', timestamp: 100, _absorbed_row_ids: [43, 44] }
    const reply = { role: 'assistant', content: 'Done', timestamp: 101 }
    const duplicate = { role: 'user', content: 'continue', timestamp: 200, _state_db_row_id: 43 }
    const secondAbsorbed = { ...duplicate, _state_db_row_id: 44 }
    const repeated = { ...duplicate, timestamp: 201, _state_db_row_id: 45 }
    const concurrent = { role: 'user', content: 'CLI work', timestamp: 201, _state_db_row_id: 46 }
    const local = [prompt, reply]
    expect(mergeSessionMessagesAppendOnly(local, [duplicate, secondAbsorbed, repeated, concurrent], { stateDbSeenId })).toEqual([...local, repeated, concurrent])
  })

  it.each([42, null])('keeps absorbed UID rows represented with seen marker %s', (stateDbSeenId) => {
    const prompt = { role: 'user', content: 'Notification prefix', timestamp: 100, message_uid: 'carrier', _absorbed_message_uids: ['absorbed'] }
    const reply = { role: 'assistant', content: 'Verified', timestamp: 101 }
    const duplicate = { role: 'user', content: 'Background result', timestamp: 200, _state_db_message_uid: 'absorbed', _state_db_row_id: 43 }
    const repeated = { ...duplicate, timestamp: 201, _state_db_message_uid: 'independent', _state_db_row_id: 44 }
    expect(mergeSessionMessagesAppendOnly([prompt, reply], [duplicate, repeated], { stateDbSeenId })).toEqual([prompt, reply, repeated])
    // Older databases can supply a UID without numeric row IDs.
    const uidOnly = { ...duplicate, _state_db_row_id: undefined }
    expect(mergeSessionMessagesAppendOnly([prompt, reply], [uidOnly], { stateDbSeenId })).toEqual([prompt, reply])
  })

  it('preserves authored edits and ignores malformed absorption metadata', () => {
    const local = [{ role: 'user', content: 'old', timestamp: 100, _absorbed_row_ids: ['43', null], _absorbed_message_uids: [null, 7, ''], message_uid: 'same' }]
    const changed = { role: 'user', content: 'edited', timestamp: 200, _state_db_row_id: 43, _state_db_message_uid: 'same', _state_db_authored_change: true }
    expect(mergeSessionMessagesAppendOnly(local, [changed], { stateDbSeenId: 42 })).toEqual([...local, changed])
  })

  it('retains exact-copy matching when an older database cannot supply UIDs', () => {
    const prompt = { role: 'user', content: 'continue', timestamp: 100, message_uid: 'agent-only' }
    const copy = { role: 'user', content: 'continue', timestamp: 100, _state_db_row_id: 43 }
    expect(mergeSessionMessagesAppendOnly([prompt], [copy], { stateDbSeenId: 42 })).toEqual([prompt])
  })

  it('scopes numeric absorption to a generation while UIDs survive database replacement', () => {
    const prompt = { role: 'user', content: 'merged', timestamp: 100, _absorbed_row_ids: [1], _absorbed_message_uids: ['absorbed'], _state_db_generation: 'old' }
    const newRow = { role: 'user', content: 'new CLI', timestamp: 200, _state_db_row_id: 1, _state_db_generation: 'new' }
    const sameOccurrence = { ...newRow, _state_db_message_uid: 'absorbed' }
    expect(mergeSessionMessagesAppendOnly([prompt], [newRow])).toEqual([prompt, newRow])
    expect(mergeSessionMessagesAppendOnly([prompt], [sameOccurrence])).toEqual([prompt])
    expect(mergeSessionMessagesAppendOnly([prompt], [{ ...newRow, _state_db_generation: 'old' }])).toEqual([prompt])
    const unknownGeneration = { ...prompt, _state_db_generation: undefined }
    expect(mergeSessionMessagesAppendOnly([unknownGeneration], [newRow], { stateDbSeenId: 0 })).toEqual([unknownGeneration, newRow])
  })
})

describe('mergeSessionMessagesAppendOnly by state.db row id (TAL-493)', () => {
  const row = (id: number, role: string, content: string, timestamp: number) => ({ role, content, timestamp, _state_db_row_id: id })
  const contents = (rows: { content?: unknown }[]) => rows.map((m) => m.content)
  const sidecar = [{ role: 'user', content: 'u1', timestamp: 100 }, { role: 'assistant', content: 'a1', timestamp: 101 }, { role: 'user', content: 'web', timestamp: 300 }, { role: 'assistant', content: 'web reply', timestamp: 301 }]

  it('appends a row committed after the last read even when it is stamped before the newest local row', () => {
    const state = [row(1, 'user', 'u1', 100), row(2, 'assistant', 'a1', 101), row(3, 'user', 'late CLI', 200), row(4, 'assistant', 'late CLI reply', 201)]
    expect(contents(mergeSessionMessagesAppendOnly(sidecar, state, { stateDbSeenId: 2 }))).toEqual(['u1', 'a1', 'web', 'web reply', 'late CLI', 'late CLI reply'])
  })

  it('appends a row stamped at or before a truncation or compression watermark once its id is past the boundary', () => {
    const state = [row(1, 'user', 'u1', 100), row(2, 'assistant', 'a1', 101), row(5, 'user', 'late', 99)]
    for (const compressedWatermark of [false, true]) expect(contents(mergeSessionMessagesAppendOnly(sidecar.slice(0, 2), state, { truncationWatermark: 101, compressedWatermark, stateDbSeenId: 2 }))).toEqual(['u1', 'a1', 'late'])
    expect(contents(mergeSessionMessagesAppendOnly([], state, { truncationWatermark: 0, stateDbSeenId: 2 }))).toEqual(['late'])
  })

  it('never replays a row the boundary covered, whatever its timestamp', () => {
    const state = [row(1, 'user', 'u1', 100), row(2, 'assistant', 'a1', 101), row(3, 'user', 'cut', 500), row(4, 'assistant', 'cut reply', 501)]
    expect(contents(mergeSessionMessagesAppendOnly(sidecar, state, { truncationWatermark: 101, stateDbSeenId: 4 }))).toEqual(['u1', 'a1', 'web', 'web reply'])
    expect(contents(mergeSessionMessagesAppendOnly([], state, { stateDbSeenId: 4 }))).toEqual([])
  })

  it('skips a new row the sidecar already holds', () => {
    expect(contents(mergeSessionMessagesAppendOnly(sidecar, [row(7, 'user', 'web', 300), row(8, 'assistant', 'CLI', 302)], { stateDbSeenId: 6 }))).toEqual(['u1', 'a1', 'web', 'web reply', 'CLI'])
  })

  it('keeps every distinct new row, matching each local row at most once', () => {
    const twins = [row(7, 'user', 'ok', 400), row(8, 'user', 'ok', 400)]
    expect(contents(mergeSessionMessagesAppendOnly(sidecar, twins, { stateDbSeenId: 6 }))).toEqual(['u1', 'a1', 'web', 'web reply', 'ok', 'ok'])
    // One local copy stands for one state row: by its id when it carries one, else by its key.
    expect(contents(mergeSessionMessagesAppendOnly([...sidecar, { role: 'user', content: 'ok', timestamp: 400 }], twins, { stateDbSeenId: 6 }))).toEqual(['u1', 'a1', 'web', 'web reply', 'ok', 'ok'])
    expect(contents(mergeSessionMessagesAppendOnly([...sidecar, row(8, 'user', 'ok', 400)], twins, { stateDbSeenId: 6 }))).toEqual(['u1', 'a1', 'web', 'web reply', 'ok', 'ok'])
  })

  it('lets a covered row match its local copy before a newer duplicate does', () => {
    const local = [...sidecar, { role: 'user', content: 'ok', timestamp: 400 }]
    expect(contents(mergeSessionMessagesAppendOnly(local, [row(3, 'user', 'ok', 400), row(7, 'user', 'ok', 400)], { stateDbSeenId: 6 }))).toEqual(['u1', 'a1', 'web', 'web reply', 'ok', 'ok'])
  })

  it('keeps the timestamp rules without a seen id or without row ids', () => {
    const late = [row(1, 'user', 'u1', 100), row(3, 'user', 'late CLI', 200)]
    expect(contents(mergeSessionMessagesAppendOnly(sidecar, late, {}))).toEqual(['u1', 'a1', 'web', 'web reply'])
    expect(contents(mergeSessionMessagesAppendOnly(sidecar, late.map(({ role, content, timestamp }) => ({ role, content, timestamp })), { stateDbSeenId: 2 }))).toEqual(['u1', 'a1', 'web', 'web reply'])
  })
})
