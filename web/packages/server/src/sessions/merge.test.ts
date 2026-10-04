import { describe, expect, it } from 'vitest'
import { BODY_EXCERPT_LIMIT, extractToolCallsFromMessages, markerKind, mergeDisplayMessagesAfterAgentResult, mergeSessionMessagesAppendOnly, normalizeAssistantDisplay, splitDisplayText, stripToolCallXml, toolOutcome, withBodyExcerpts, withDisplayMedia, withMarkerKinds, withToolCallOutcomes } from './merge.js'

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
    const [reply] = withBodyExcerpts(withDisplayMedia([{ role: 'assistant', content: long, _anchor_activity_scene: scene }], longProject), null) as Record<string, unknown>[]
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
    const out = withMarkerKinds(rows) as Record<string, unknown>[]
    expect(out[0]).toEqual({ ...rows[0], _marker_kind: 'context_compaction' })
    expect(out[1]).toEqual({ ...rows[1], _marker_kind: 'preserved_task_list', _marker_body: '- [ ] one\n- [x] two' })
    expect(out[2]).toBe(rows[2])
    expect(rows[0]).not.toHaveProperty('_marker_kind')
  })

  it('drops bracketed markers of either case from the settled display', () => {
    const previous = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: '[context compaction] old summary' }]
    const result = [...previous.slice(0, 2), { role: 'user', content: '[CONTEXT COMPACTION] new summary' }, { role: 'user', content: 'Next' }, { role: 'assistant', content: 'Context compaction is a summary step.' }]
    const merged = mergeDisplayMessagesAfterAgentResult(previous, previous, result, 'Next')
    expect(merged.map((m) => m.content)).toEqual(['Hi', 'Hello', 'Next', 'Context compaction is a summary step.'])
  })
})
