import { expect, it } from 'vitest'
import { PromptReplayFilter, runRowsAfter, type JournalEvent } from './journal.js'

const row = (run: string, seq: number, event: string, payload: unknown = {}, terminal = false): JournalEvent => ({ version: 1, event_id: `${run}:${String(seq)}`, seq, run_id: run, session_id: 's', event, type: event, created_at: seq, terminal, terminal_state: null, payload })

// TAL-1561: what a prompt row's own run proves about it; anything unproven stays visible.
it('settles prompts only from readable same-run evidence after them', async () => {
  const rows = [
    row('r', 1, 'approval', { approval_id: 'a1' }), row('r', 2, 'clarify', { clarify_id: 'q1' }), row('r', 3, 'tool_complete', { name: 'clarify' }),
    row('r', 4, 'approval', { approval_id: 'a2' }), row('r', 5, 'clarify', { status: 'resolved', clarify_id: 'q1' }), row('r', 6, 'tool_complete', 'garbled'),
    row('r', 7, 'clarify', { clarify_id: 'q2' }), row('r', 8, 'done', {}, true), row('r', 9, 'approval', { approval_id: 'late' }),
    row('other', 10, 'tool_complete', { name: 'clarify' }), row('other', 11, 'done', {}, true),
  ]
  const filter = new PromptReplayFilter((prompt) => runRowsAfter(prompt, rows))
  const visible = async (entry: JournalEvent) => filter.visible(entry)
  expect(await Promise.all(rows.map(visible))).toEqual([false, false, true, false, true, true, false, true, true, true, true])
  // Another run's evidence and a malformed seq or run never settle anything.
  expect(await visible(row('third', 1, 'clarify'))).toBe(true)
  expect(await visible({ ...row('r', 2, 'clarify'), seq: 0 })).toBe(true)
  expect(await visible({ ...row('r', 2, 'clarify'), run_id: '' })).toBe(true)
  // A run known to be live keeps its approvals without reading ahead; its questions still settle.
  const live = new PromptReplayFilter((prompt) => runRowsAfter(prompt, rows), 'r')
  expect(await live.visible(rows[0]!)).toBe(true)
  expect(await live.visible(rows[1]!)).toBe(false)
})
