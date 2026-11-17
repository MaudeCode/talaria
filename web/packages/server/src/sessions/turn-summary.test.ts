import type { ToolOutcome } from '@maudecode/talaria-web-contracts'
import { describe, expect, it } from 'vitest'
import { turnSummary } from './turn-summary.js'

const call = (name: string, outcome?: Partial<ToolOutcome> & Pick<ToolOutcome, 'key'>, extra: { args?: unknown; is_error?: boolean } = {}) =>
  ({ tool: { name, args: extra.args ?? {}, is_error: extra.is_error ?? false, result_view: outcome ? { outcome: { tone: 'neutral' as const, ...outcome } } : null } })

describe('turnSummary', () => {
  it('counts each kind of change in the fixed order, a memory write by its entries', () => {
    expect(turnSummary([
      call('session_send', { key: 'sent' }),
      call('cronjob_manage', { key: 'paused' }),
      call('memory', { key: 'memory_added', count: 2 }),
      call('memory', { key: 'memory_updated', count: 1 }),
      call('kanban_complete', { key: 'completed' }),
      call('kanban_request_review', { key: 'moved_to', value: 'Review' }),
      call('skill_manage', { key: 'removed' }),
      call('cronjob_manage', { key: 'removed' }),
      call('write_file', undefined, { args: { path: 'a.ts' } }),
      call('patch', undefined, { args: { path: 'b.ts' } }),
      call('patch', undefined, { args: { path: 'a.ts' } }),
    ])).toEqual([
      { key: 'files_changed', count: 2 }, { key: 'memories_saved', count: 3 }, { key: 'skills_updated', count: 1 },
      { key: 'schedules_changed', count: 2 }, { key: 'tasks_updated', count: 2 }, { key: 'messages_sent', count: 1 },
    ])
  })

  it('leaves out failed calls, staged writes and outcomes that change nothing', () => {
    expect(turnSummary([
      call('write_file', { key: 'failed', tone: 'error', value: 'Permission denied' }, { args: { path: 'a.ts' }, is_error: true }),
      call('memory', { key: 'pending_approval', tone: 'attention' }),
      call('approval_respond', { key: 'approved' }),
      call('cronjob_manage', { key: 'ran_now' }),
      call('memory', { key: 'memory_removed', count: 1 }),
      call('mcp__github__delete_repo', { key: 'removed' }),
      call('search_files', { key: 'no_matches' }),
      call('read_file', undefined, { args: { path: 'a.ts' } }),
    ])).toEqual([])
    expect(turnSummary([])).toEqual([])
  })
})
