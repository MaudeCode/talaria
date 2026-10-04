import { describe, expect, it } from 'vitest'
import type { Message } from './session.js'
import { truncateContextForDisplayKeep } from './service.js'

const contents = (rows: Message[]): unknown[] => rows.map((row) => row.content)

/** Ported from the Python `test_issue_branch_context_at_fork.py` (#5096 A). */
describe('truncateContextForDisplayKeep', () => {
  it('drops the parent tail', () => {
    const msgs = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'after-fork' }]
    const out = truncateContextForDisplayKeep(structuredClone(msgs), msgs, 2)
    expect(contents(out)).toEqual(['u1', 'a1'])
  })

  it('preserves a leading compaction row', () => {
    const msgs = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }]
    const ctx = [{ role: 'user', content: 'compaction-ref-only' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }]
    expect(contents(truncateContextForDisplayKeep(ctx, msgs, 2))).toEqual(['compaction-ref-only', 'u1', 'a1'])
  })

  const fourTurns = [
    { role: 'user', content: 'u1', id: 'u1', timestamp: 1.0 },
    { role: 'assistant', content: 'a1', id: 'a1', timestamp: 2.0 },
    { role: 'user', content: 'u2', id: 'u2', timestamp: 3.0 },
    { role: 'assistant', content: 'a2', id: 'a2', timestamp: 4.0 },
  ]

  it('drops an interleaved tool tail', () => {
    const ctx = [
      fourTurns[0]!, fourTurns[1]!, fourTurns[2]!,
      { role: 'assistant', content: 'tool-call-after-cut', id: 'tool-call-after-cut' },
      { role: 'tool', content: 'tool-result-after-cut', id: 'tool-result-after-cut' },
      fourTurns[3]!,
    ]
    expect(contents(truncateContextForDisplayKeep(ctx, fourTurns, 2))).toEqual(['u1', 'a1'])
  })

  it('keeps tool rows before the next display anchor', () => {
    const ctx = [
      fourTurns[0]!, fourTurns[1]!,
      { role: 'assistant', content: 'assistant-think', id: 'a1-think' },
      { role: 'assistant', content: 'assistant-tool-result', id: 'a1-tool', timestamp: 2.5 },
      fourTurns[2]!, fourTurns[3]!,
    ]
    expect(contents(truncateContextForDisplayKeep(ctx, fourTurns, 2))).toEqual(['u1', 'a1', 'assistant-think', 'assistant-tool-result'])
  })

  it('drops unkept tool rows after a user boundary', () => {
    const ctx = [
      fourTurns[0]!, fourTurns[1]!, fourTurns[2]!,
      { role: 'assistant', content: 'tool-call-after-user-keep', id: 'tool-call-after-user-keep' },
      { role: 'tool', content: 'tool-result-after-user-keep', id: 'tool-result-after-user-keep' },
      fourTurns[3]!,
    ]
    expect(contents(truncateContextForDisplayKeep(ctx, fourTurns, 3))).toEqual(['u1', 'a1', 'u2'])
  })

  it('keeps the kept assistant reply after a compact summary', () => {
    const ctx = [{ role: 'user', content: 'compact', id: 'summary' }, fourTurns[0]!, fourTurns[1]!]
    expect(contents(truncateContextForDisplayKeep(ctx, fourTurns, 2))).toEqual(['compact', 'u1', 'a1'])
  })

  it('keeps the real user turn when duplicate rows lack identity', () => {
    const msgs = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }]
    const ctx = [{ role: 'user', content: 'u1' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }]
    expect(contents(truncateContextForDisplayKeep(ctx, msgs, 1))).toEqual(['u1', 'u1'])
  })

  it('cuts a shorter context at the last aligned turn boundary', () => {
    const msgs = [
      { role: 'user', content: 'u1', timestamp: 1.0 },
      { role: 'assistant', content: 'a1', timestamp: 2.0, tool_calls: [{ id: 'c1' }] },
      { role: 'tool', content: 'r1', tool_call_id: 'c1', timestamp: 3.0 },
      { role: 'assistant', content: 'done', timestamp: 4.0 },
      { role: 'user', content: 'u2', timestamp: 5.0 },
      { role: 'assistant', content: 'a2', timestamp: 6.0, tool_calls: [{ id: 'c2' }] },
    ]
    const ctx = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', content: 'r1', tool_call_id: 'c1' },
      { role: 'assistant', content: 'a2', tool_calls: [{ id: 'c2' }] },
      { role: 'tool', content: 'r2', tool_call_id: 'c2' },
    ]
    const out = truncateContextForDisplayKeep(ctx, msgs, 4)
    expect(contents(out)).toEqual(['u1', 'a1', 'r1'])
  })

  it('keeps the forked turn through a weak match in a shorter context', () => {
    const msgs = [
      { role: 'user', content: 'u1', id: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ]
    const ctx = [{ role: 'user', content: 'u1', id: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'assistant', content: 'a1' }]
    expect(contents(truncateContextForDisplayKeep(ctx, msgs, 2))).toEqual(['u1', 'a1'])
  })

  it('falls back to a best-effort prefix when nothing aligns', () => {
    const msgs = [{ role: 'user', content: 'u1', id: 'u1' }, { role: 'assistant', content: 'a1', id: 'a1' }, { role: 'user', content: 'u2', id: 'u2' }]
    const ctx = [{ role: 'user', content: 'summary-1' }, { role: 'assistant', content: 'summary-2' }]
    expect(contents(truncateContextForDisplayKeep(ctx, msgs, 2))).toEqual(['summary-1', 'summary-2'])
  })

  it('keeps the tool tail before an ambiguous unkept anchor', () => {
    const msgs = [
      { role: 'user', content: 'u1', id: 'u1' },
      { role: 'assistant', content: 'a1', id: 'a1', tool_calls: [{ id: 'kept-tool' }] },
      { role: 'user', content: 'u2' },
    ]
    const ctx = [
      msgs[0]!, msgs[1]!,
      { role: 'tool', content: 'kept-tool-result', tool_call_id: 'kept-tool' },
      { role: 'user', content: 'u2' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2', id: 'a2' },
    ]
    expect(contents(truncateContextForDisplayKeep(ctx, msgs, 2))).toEqual(['u1', 'a1', 'kept-tool-result'])
  })

  it('cuts a compressed context at the kept display boundary', () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${String(i)}`, id: `m${String(i)}`, timestamp: i }))
    const ctx = [{ role: 'user', content: 'summary' }, ...msgs.slice(34)]
    expect(contents(truncateContextForDisplayKeep(ctx, msgs, 36))).toEqual(['summary', 'm34', 'm35'])
  })

  it('ignores display-only error rows when cutting', () => {
    const msgs = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: 'Provider failed', _error: true },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ]
    const ctx = [msgs[0]!, msgs[1]!, msgs[3]!, msgs[4]!]
    expect(contents(truncateContextForDisplayKeep(ctx, msgs, 3))).toEqual(['u1', 'a1'])
  })
})
