import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackgroundTaskStore, backgroundLink, dispatchedDelegationIds, eventReceipt, taskView } from './background-tasks.js'

const dirs: string[] = []
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'bg-tasks-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('background task records (TAL-372)', () => {
  it('survive a restart: a new store over the same directory reads the same records and results', () => {
    const dir = tempDir()
    const changes: string[] = []
    const first = new BackgroundTaskStore(dir, () => 100, (sid) => changes.push(sid))
    first.update('sess-1', [{ task_id: 'bg1', kind: 'background_command', status: 'running', title: 'summarize', started_at: 90 }])
    first.update('sess-1', [{ task_id: 'bg1', kind: 'background_command', status: 'completed', result: 'the answer' }])
    expect(changes).toEqual(['sess-1', 'sess-1'])
    const restarted = new BackgroundTaskStore(dir, () => 200)
    expect(restarted.list('sess-1').map((r) => taskView(r))).toEqual([expect.objectContaining({ task_id: 'bg1', status: 'completed', title: 'summarize', completed_at: 100, result_available: true, pinned: true })])
    expect(restarted.get('sess-1', 'bg1')?.result).toBe('the answer')
    expect(restarted.list('other')).toEqual([])
  })

  it('settle once: a later report never reopens or changes a finished record, and an unchanged report writes nothing', () => {
    const changes: string[] = []
    const store = new BackgroundTaskStore(tempDir(), () => 100, (sid) => changes.push(sid))
    store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'running', title: 'Check logs' }])
    store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'failed' }])
    store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'running' }, { task_id: 'd1', kind: 'delegation', status: 'completed', result: 'late detail' }])
    expect(store.list('s')).toEqual([expect.objectContaining({ task_id: 'd1', status: 'failed', result: 'late detail' })])
    const before = changes.length
    expect(store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'completed' }])).toBe(false)
    expect(changes).toHaveLength(before)
  })

  it('read a split unit\'s completion by its own subagents', () => {
    const receipt = eventReceipt({ type: 'async_delegation', process_id: 'call-1-2', status: 'completed', goals: ['Docs', 'Tests', 'Run'], results: [{ task_index: 1, status: 'completed' }, { task_index: 2, status: 'error' }] }, '[done]\nresults', 50)
    expect(receipt).toMatchObject({ task_id: 'call-1-2', kind: 'delegation', status: 'completed', title: '2 subagents: Tests; Run', agents: { total: 2, completed: 1, failed: 1, running: 0 }, result: '[done]\nresults' })
    expect(eventReceipt({ type: 'async_delegation', process_id: 'd2', status: 'interrupted', goal: 'Stop me' }, '', 50)).toMatchObject({ status: 'cancelled' })
    expect(eventReceipt({ type: 'watch_match', process_id: 'proc_w', command: 'tail log' }, '[IMPORTANT: matched]', 50)).toMatchObject({ kind: 'process', status: 'attention' })
  })

  it('keep running work when pruning old history', () => {
    let clock = 0
    const store = new BackgroundTaskStore(tempDir(), () => ++clock)
    store.update('s', [{ task_id: 'live', kind: 'process', status: 'running', title: 'server' }])
    for (let i = 0; i < 205; i++) store.update('s', [{ task_id: `p${i}`, kind: 'process', status: 'completed', title: 'x' }], { notify: false })
    const ids = store.list('s').map((r) => r.task_id)
    expect(ids).toContain('live')
    expect(ids).toHaveLength(201)
    expect(ids).not.toContain('p0')
  })

  it('link a delegation row to its units by the call id, even when the result is clipped before the units list', () => {
    const clipped = '{"status": "dispatched", "mode": "background", "count": 3, "delegation_id": "call-1", "goals": ["Docs", "Tes'
    expect(dispatchedDelegationIds(clipped)).toEqual(['call-1'])
    expect(dispatchedDelegationIds('{"status": "completed", "delegation_id": "x"}')).toEqual([])
    const store = new BackgroundTaskStore(tempDir(), () => 1)
    store.update('s', [{ task_id: 'call-1-1', kind: 'delegation', status: 'attention', agents: { total: 1, completed: 0, failed: 0, running: 1 } }, { task_id: 'call-10', kind: 'delegation', status: 'running' }])
    expect(backgroundLink(['call-1'], store.list('s'))).toEqual({ task_ids: ['call-1-1'], status: 'attention', agents: { total: 1, completed: 0, failed: 0, running: 1 } })
  })

  it('let anyone dismiss work nobody can confirm, which then leaves the card until it is confirmed running again', () => {
    const store = new BackgroundTaskStore(tempDir(), () => 5)
    store.update('s', [{ task_id: 'proc_lost', kind: 'process', status: 'running', title: 'server' }])
    const lost = store.get('s', 'proc_lost')!
    expect(taskView(lost, { unconfirmed: true })).toMatchObject({ status: 'unknown', pinned: true, dismissible: true })
    const dismissed = store.mark('s', 'proc_lost', { dismissed_at: 6 })!
    expect(taskView(dismissed, { unconfirmed: true })).toMatchObject({ status: 'unknown', pinned: false, dismissible: false })
    expect(taskView(dismissed)).toMatchObject({ status: 'running', pinned: true, dismissible: false })
  })

  it('keep a matched watch in attention while the process runs, and clear a recovered agent stall', () => {
    const store = new BackgroundTaskStore(tempDir(), () => 1)
    store.update('s', [{ task_id: 'proc_w', kind: 'process', status: 'running', title: 'tail log' }])
    store.update('s', [{ task_id: 'proc_w', kind: 'process', status: 'attention' }])
    store.update('s', [{ task_id: 'proc_w', kind: 'process', status: 'running' }])
    expect(store.get('s', 'proc_w')?.status).toBe('attention')
    store.update('s', [{ task_id: 'proc_w', kind: 'process', status: 'completed' }])
    expect(store.get('s', 'proc_w')?.status).toBe('completed')
    store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'attention' }, { task_id: 'd1', kind: 'delegation', status: 'running' }])
    expect(store.get('s', 'd1')?.status).toBe('running')
  })
})

