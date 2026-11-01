import { testSessionDocuments } from '../test/storage.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackgroundActivity, BackgroundTaskStore, backgroundLink, dispatchedDelegationIds, eventReceipt, startsBackgroundWork, taskView } from './background-tasks.js'
import type { SidecarLike } from '../sidecar/client.js'
import type { DocumentBackend } from './storage/backend.js'

const dirs: string[] = []
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'bg-tasks-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('background task records (TAL-372)', () => {
  it('survive a restart: a new store over the same directory reads the same records and results', async () => {
    const dir = tempDir()
    const changes: string[] = []
    const first = new BackgroundTaskStore(testSessionDocuments(dir), () => 100, (sid) => { changes.push(sid) })
    await first.update('sess-1', [{ task_id: 'bg1', kind: 'background_command', status: 'running', title: 'summarize', started_at: 90 }])
    await first.update('sess-1', [{ task_id: 'bg1', kind: 'background_command', status: 'completed', result: 'the answer' }])
    expect(changes).toEqual(['sess-1', 'sess-1'])
    const restarted = new BackgroundTaskStore(testSessionDocuments(dir), () => 200)
    expect((await restarted.list('sess-1')).map((r) => taskView(r))).toEqual([expect.objectContaining({ task_id: 'bg1', status: 'completed', title: 'summarize', completed_at: 100, result_available: true, pinned: true })])
    expect((await restarted.get('sess-1', 'bg1'))?.result).toBe('the answer')
    expect((await restarted.list('other'))).toEqual([])
  })

  it('read a receipt an older server marked legacy_reported: it lists, dismisses and returns its result', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, '_background'))
    writeFileSync(join(dir, '_background', 'sess-1.json'), JSON.stringify({ version: 1, tasks: [{ task_id: 'bg1', kind: 'background_command', status: 'completed', title: 'summarize', started_at: 90, updated_at: 100, completed_at: 100, exit_code: null, agents: null, result: 'the answer', agent_result: false, stream_id: null, dismissed_at: null, legacy_reported: true }] }))
    const activity = new BackgroundActivity({ store: new BackgroundTaskStore(testSessionDocuments(dir), () => 200), sidecar: () => null, profileHome: () => dir, liveStream: () => false, now: () => 200, log: () => undefined })
    expect((await activity.snapshot('sess-1', null)).tasks).toEqual([expect.objectContaining({ task_id: 'bg1', status: 'completed', result_available: true, pinned: true, dismissible: true })])
    expect(await activity.result('sess-1', null, 'bg1')).toBe('the answer')
    expect((await activity.dismiss('sess-1', 'bg1'))).toMatchObject({ task_id: 'bg1', pinned: false, dismissible: false })
    expect((await activity.snapshot('sess-1', null)).tasks).toEqual([expect.objectContaining({ task_id: 'bg1', pinned: false })])
  })

  it('settle once: a later report never reopens or changes a finished record, and an unchanged report writes nothing', async () => {
    const changes: string[] = []
    const store = new BackgroundTaskStore(testSessionDocuments(tempDir()), () => 100, (sid) => { changes.push(sid) })
    await store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'running', title: 'Check logs' }])
    await store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'failed' }])
    await store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'running' }, { task_id: 'd1', kind: 'delegation', status: 'completed', result: 'late detail' }])
    expect((await store.list('s'))).toEqual([expect.objectContaining({ task_id: 'd1', status: 'failed', result: 'late detail' })])
    const before = changes.length
    expect((await store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'completed' }]))).toBe(false)
    expect(changes).toHaveLength(before)
  })

  it('read a split unit\'s completion by its own subagents', () => {
    const receipt = eventReceipt({ type: 'async_delegation', process_id: 'call-1-2', status: 'completed', goals: ['Docs', 'Tests', 'Run'], results: [{ task_index: 1, status: 'completed' }, { task_index: 2, status: 'error' }] }, '[done]\nresults', 50)
    expect(receipt).toMatchObject({ task_id: 'call-1-2', kind: 'delegation', status: 'completed', title: '2 subagents: Tests; Run', agents: { total: 2, completed: 1, failed: 1, running: 0 }, result: '[done]\nresults' })
    expect(eventReceipt({ type: 'async_delegation', process_id: 'd2', status: 'interrupted', goal: 'Stop me' }, '', 50)).toMatchObject({ status: 'cancelled' })
    expect(eventReceipt({ type: 'watch_match', process_id: 'proc_w', command: 'tail log' }, '[IMPORTANT: matched]', 50)).toMatchObject({ kind: 'process', status: 'attention' })
  })

  it('keep running work when pruning old history', async () => {
    let clock = 0
    const store = new BackgroundTaskStore(testSessionDocuments(tempDir()), () => ++clock)
    await store.update('s', [{ task_id: 'live', kind: 'process', status: 'running', title: 'server' }])
    for (let i = 0; i < 205; i++) (await store.update('s', [{ task_id: `p${i}`, kind: 'process', status: 'completed', title: 'x' }], { notify: false }))
    const ids = (await store.list('s')).map((r) => r.task_id)
    expect(ids).toContain('live')
    expect(ids).toHaveLength(201)
    expect(ids).not.toContain('p0')
  })

  it('link a delegation row to its units by the call id, even when the result is clipped before the units list', async () => {
    const clipped = '{"status": "dispatched", "mode": "background", "count": 3, "delegation_id": "call-1", "goals": ["Docs", "Tes'
    expect(dispatchedDelegationIds(clipped)).toEqual(['call-1'])
    expect(dispatchedDelegationIds('{"status": "completed", "delegation_id": "x"}')).toEqual([])
    const store = new BackgroundTaskStore(testSessionDocuments(tempDir()), () => 1)
    await store.update('s', [{ task_id: 'call-1-1', kind: 'delegation', status: 'attention', agents: { total: 1, completed: 0, failed: 0, running: 1 } }, { task_id: 'call-10', kind: 'delegation', status: 'running' }])
    expect(backgroundLink(['call-1'], (await store.list('s')))).toEqual({ task_ids: ['call-1-1'], status: 'attention', agents: { total: 1, completed: 0, failed: 0, running: 1 } })
  })

  it('let anyone dismiss work nobody can confirm, which then leaves the card until it is confirmed running again', async () => {
    const store = new BackgroundTaskStore(testSessionDocuments(tempDir()), () => 5)
    await store.update('s', [{ task_id: 'proc_lost', kind: 'process', status: 'running', title: 'server' }])
    const lost = (await store.get('s', 'proc_lost'))!
    expect(taskView(lost, { unconfirmed: true })).toMatchObject({ status: 'unknown', pinned: true, dismissible: true })
    const dismissed = (await store.mark('s', 'proc_lost', { dismissed_at: 6 }))!
    expect(taskView(dismissed, { unconfirmed: true })).toMatchObject({ status: 'unknown', pinned: false, dismissible: false, active: false })
    expect(taskView(dismissed)).toMatchObject({ status: 'running', pinned: true, dismissible: false })
  })

  it('keep a matched watch in attention while the process runs, and clear a recovered agent stall', async () => {
    const store = new BackgroundTaskStore(testSessionDocuments(tempDir()), () => 1)
    await store.update('s', [{ task_id: 'proc_w', kind: 'process', status: 'running', title: 'tail log' }])
    await store.update('s', [{ task_id: 'proc_w', kind: 'process', status: 'attention' }])
    await store.update('s', [{ task_id: 'proc_w', kind: 'process', status: 'running' }])
    expect((await store.get('s', 'proc_w'))?.status).toBe('attention')
    await store.update('s', [{ task_id: 'proc_w', kind: 'process', status: 'completed' }])
    expect((await store.get('s', 'proc_w'))?.status).toBe('completed')
    await store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'attention' }, { task_id: 'd1', kind: 'delegation', status: 'running' }])
    expect((await store.get('s', 'd1'))?.status).toBe('running')
  })

  it('keep the child sessions a delegation ran once seen, through completion and a restart, exposing only safe ids (TAL-494)', async () => {
    const dir = tempDir()
    const store = new BackgroundTaskStore(testSessionDocuments(dir), () => 1)
    await store.update('s', [{ task_id: 'call-1-2', kind: 'delegation', status: 'running', children: [{ goal: 'Write tests', session_id: 'child-1' }] }])
    // The Agent forgets a finished child's id: the completion and a later report name none, or only another one.
    await store.update('s', [{ task_id: 'call-1-2', kind: 'delegation', status: 'completed' }])
    await store.update('s', [{ task_id: 'call-1-2', kind: 'delegation', status: 'completed', children: [{ goal: 'Run tests', session_id: 'child-2' }, { goal: 'Write tests', session_id: 'child-1' }] }])
    const restarted = new BackgroundTaskStore(testSessionDocuments(dir), () => 2)
    expect(taskView((await restarted.get('s', 'call-1-2'))!).child_sessions).toEqual([{ goal: 'Write tests', session_id: 'child-1' }, { goal: 'Run tests', session_id: 'child-2' }])
    await restarted.update('s', [{ task_id: 'bad', kind: 'delegation', status: 'running', children: [{ goal: 'x', session_id: '../etc' }] }])
    expect(taskView((await restarted.get('s', 'bad'))!).child_sessions).toEqual([])
  })

  it('refresh only for a dispatched delegation or a shell call that started a registry process (TAL-1305)', () => {
    // The tool results as the sidecar forwards them (`raw_result`): the Agent's own result objects.
    expect(startsBackgroundWork('delegate_task', { status: 'dispatched', delegation_id: 'call_d' })).toBe(true)
    expect(startsBackgroundWork('delegate_task', { status: 'completed', results: [{ status: 'completed', summary: 'ok' }] })).toBe(false)
    expect(startsBackgroundWork('terminal', { output: 'Background process started', session_id: 'proc_0123456789ab', pid: 7, exit_code: 0, notify_on_complete: true })).toBe(true)
    expect(startsBackgroundWork('terminal', { status: 'yielded_to_background', session_id: 'proc_0123456789ab', pid: 7, notify_on_complete: true })).toBe(true)
    expect(startsBackgroundWork('terminal', { output: 'done', exit_code: 0, error: null })).toBe(false)
    expect(startsBackgroundWork('terminal', 'plain text output')).toBe(false)
    expect(startsBackgroundWork('read_file', { session_id: 'proc_0123456789ab' })).toBe(false)
  })

  it('refresh a session one Agent read at a time, reading once more after a burst (TAL-1305)', async () => {
    const dir = tempDir()
    const gates: (() => void)[] = []
    const sidecar = { call: () => new Promise((resolve) => { gates.push(() => { resolve({ delegations: [], processes: [] }) }) }) } as unknown as SidecarLike
    const activity = new BackgroundActivity({ store: new BackgroundTaskStore(testSessionDocuments(dir), () => 200), sidecar: () => sidecar, profileHome: () => dir, liveStream: () => false, now: () => 200, log: () => undefined })
    for (let i = 0; i < 5; i++) activity.refresh('s', null)
    activity.refresh('other', null)
    await expect.poll(() => gates.length).toBe(2)
    gates.shift()!()
    await expect.poll(() => gates.length).toBe(2)
    gates.splice(0).forEach((open) => { open() })
    await new Promise((r) => setTimeout(r, 20))
    expect(gates).toHaveLength(0)
  })

  it('leave the records as they are when a refresh cannot reach the Agent (TAL-1305)', async () => {
    const dir = tempDir()
    let changes = 0
    const store = new BackgroundTaskStore(testSessionDocuments(dir), () => 200, () => { changes += 1 })
    await store.update('s', [{ task_id: 'd1', kind: 'delegation', status: 'running', title: 'Check logs' }])
    changes = 0
    const sidecar = { call: () => Promise.reject(new Error('agent down')) } as unknown as SidecarLike
    const logged: string[] = []
    const activity = new BackgroundActivity({ store, sidecar: () => sidecar, profileHome: () => dir, liveStream: () => false, now: () => 200, log: (line) => { logged.push(line) } })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      activity.refresh('s', null)
      // Every retry fails the same way and changes nothing.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(logged).toHaveLength(4)
      expect((await store.get('s', 'd1'))?.status).toBe('running')
      expect(changes).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('retry a refresh that could not reach the Agent a few times, so the work it started still shows (TAL-1305)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const dir = tempDir()
      let changes = 0
      const store = new BackgroundTaskStore(testSessionDocuments(dir), () => 200, () => { changes += 1 })
      const unit = { delegation_id: 'd1', origin_ui_session_id: 's', state: 'running', dispatched_at: 10, completed_at: null, updated_at: 11, goals: ['Check logs'], child_statuses: [], has_result: false, live_status: 'running' }
      let calls = 0
      const sidecar = { call: () => { calls += 1; return calls < 3 ? Promise.reject(new Error('sidecar restarting')) : Promise.resolve({ delegations: [unit], processes: [] }) } } as unknown as SidecarLike
      const activity = new BackgroundActivity({ store, sidecar: () => sidecar, profileHome: () => dir, liveStream: () => false, now: () => 200, log: () => undefined })
      activity.refresh('s', null)
      await vi.waitFor(() => { expect(calls).toBe(1) })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toBe(2)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(calls).toBe(3)
      await vi.waitFor(() => { expect(changes).toBe(1) })
      expect((await store.get('s', 'd1'))?.status).toBe('running')
      // It found the Agent: no further reads.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(3)
    } finally { vi.useRealTimers() }
  })

  it('stop retrying a refresh after a few failed reads (TAL-1305)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const dir = tempDir()
      let calls = 0
      const sidecar = { call: () => { calls += 1; return Promise.reject(new Error('agent down')) } } as unknown as SidecarLike
      const activity = new BackgroundActivity({ store: new BackgroundTaskStore(testSessionDocuments(dir), () => 200), sidecar: () => sidecar, profileHome: () => dir, liveStream: () => false, now: () => 200, log: () => undefined })
      activity.refresh('s', null)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(calls).toBe(4)
    } finally { vi.useRealTimers() }
  })
})

it('can_stop requires confirmed session-owned running Agent work (TAL-1172)', async () => {
  const store = new BackgroundTaskStore(testSessionDocuments(tempDir()), () => 200)
  await store.update('s', [{ task_id: 'bg1', kind: 'background_command', status: 'running', stream_id: 'stream' }])
  const process = (id: string, owner: string, exited = false) => ({ process_id: id, session_key: owner, command: 'test', started_at: 1, exited, exited_at: exited ? 10 : null, exit_code: null, completion_reason: '', watched: false })
  const delegation = (id: string, owner: string, live: string | null) => ({ delegation_id: id, origin_ui_session_id: owner, state: 'running', dispatched_at: 1, completed_at: null, updated_at: 1, goals: ['review'], child_statuses: [], has_result: false, live_status: live })
  const sidecar = { call: () => Promise.resolve({ processes: [process('p1', 's'), process('done', 's', true), process('foreign', 'other')], delegations: [delegation('d1', 's', 'stalling'), delegation('lost', 's', null), delegation('foreign-d', 'other', 'running')] }) } as unknown as SidecarLike
  const activity = new BackgroundActivity({ store, sidecar: () => sidecar, profileHome: () => '/test-profile', liveStream: () => true, now: () => 200, log: () => undefined })
  const tasks = (await activity.snapshot('s', 'work')).tasks
  expect(tasks.filter((t) => t.can_stop).map((t) => t.task_id).sort()).toEqual(['d1', 'p1'])
  expect(tasks.map((t) => t.task_id)).not.toContain('foreign')
  expect(tasks.map((t) => t.task_id)).not.toContain('foreign-d')
  expect(tasks.find((t) => t.task_id === 'done')).toMatchObject({ can_stop: false })
  expect(tasks.find((t) => t.task_id === 'lost')).toMatchObject({ status: 'unknown', can_stop: false })
  expect(tasks.find((t) => t.task_id === 'bg1')).toMatchObject({ status: 'running', can_stop: false })
  expect((await activity.snapshot('s', 'work', { canStop: false })).tasks.every((t) => t.can_stop === false)).toBe(true)
})


it('does not recreate deleted background receipts when an earlier Agent read finishes (TAL-1520)', async () => {
  const store = new BackgroundTaskStore(testSessionDocuments(tempDir()), () => 100)
  await store.update('session', [{ task_id: 'proc_old', kind: 'process', status: 'running' }])
  let release!: () => void
  const sidecar = { call: () => new Promise((resolve) => { release = () => { resolve({ delegations: [], processes: [{ process_id: 'proc_old', session_key: 'session', command: 'Synthetic', started_at: 90, exited: false, exited_at: null, exit_code: null, completion_reason: '', watched: false }] }) } }) } as unknown as SidecarLike
  const activity = new BackgroundActivity({ store, sidecar: () => sidecar, profileHome: () => '', liveStream: () => false, now: () => 100, log: () => undefined })
  const read = activity.snapshot('session', null)
  const rejected = expect(read).rejects.toThrow('Background session changed')
  await store.delete('session')
  release()
  await rejected
  expect(await store.list('session')).toEqual([])
  expect(await store.sessionIds()).toEqual([])
})

/** TAL-1299: a document backend whose next reads can be held after reading, or fail once, on demand. */
function controlledReads(inner: DocumentBackend) {
  const held: (() => void)[] = []
  let hold = 0
  let fail = 0
  let reads = 0
  const backend: DocumentBackend = {
    get: async (namespace, key, opts) => {
      reads += 1
      if (fail > 0) { fail -= 1; throw new Error('Synthetic transient read failure') }
      const value = await inner.get(namespace, key, opts)
      if (hold > 0) { hold -= 1; await new Promise<void>((resolve) => { held.push(resolve) }) }
      return value
    },
    put: (namespace, key, value, expected) => inner.put(namespace, key, value, expected),
    delete: (namespace, key, expected) => inner.delete(namespace, key, expected),
    list: (namespace) => inner.list(namespace),
  }
  return {
    backend,
    holdNext: () => { hold += 1 },
    failNext: () => { fail += 1 },
    reads: () => reads,
    held: () => vi.waitFor(() => { expect(held).toHaveLength(1) }),
    release: () => { held.shift()!() },
  }
}

describe('background receipt cache (TAL-1299)', () => {
  const seeded = async (dir: string, receipts: Parameters<BackgroundTaskStore['update']>[1]): Promise<void> => { await new BackgroundTaskStore(testSessionDocuments(dir), () => 100).update('s', receipts) }

  it('keeps a committed update or mark when an older cold read finishes after it', async () => {
    const dir = tempDir()
    await seeded(dir, [{ task_id: 'bg1', kind: 'background_command', status: 'running', title: 'summarize' }])
    const reads = controlledReads(testSessionDocuments(dir))
    const store = new BackgroundTaskStore(reads.backend, () => 200)
    reads.holdNext()
    const stale = store.list('s')
    await reads.held()
    await store.update('s', [{ task_id: 'bg1', kind: 'background_command', status: 'completed', result: 'the answer' }])
    reads.release()
    expect(await stale).toEqual([expect.objectContaining({ task_id: 'bg1', status: 'completed' })])
    expect(await store.list('s')).toEqual([expect.objectContaining({ task_id: 'bg1', status: 'completed' })])
    expect((await store.get('s', 'bg1'))?.result).toBe('the answer')

    const marked = new BackgroundTaskStore(reads.backend, () => 300)
    reads.holdNext()
    const older = marked.list('s')
    await reads.held()
    await marked.mark('s', 'bg1', { dismissed_at: 300 })
    reads.release()
    await older
    expect((await marked.get('s', 'bg1'))?.dismissed_at).toBe(300)
  })

  it('does not let a read held across an evict or delete repopulate obsolete receipts', async () => {
    const dir = tempDir()
    await seeded(dir, [{ task_id: 'bg1', kind: 'background_command', status: 'running', title: 'summarize' }])
    const reads = controlledReads(testSessionDocuments(dir))
    const store = new BackgroundTaskStore(reads.backend, () => 200)
    reads.holdNext()
    const stale = store.list('s')
    await reads.held()
    await seeded(dir, [{ task_id: 'bg1', kind: 'background_command', status: 'completed', result: 'external' }])
    store.evict('s')
    reads.release()
    expect(await stale).toEqual([expect.objectContaining({ task_id: 'bg1', status: 'completed' })])
    expect((await store.get('s', 'bg1'))?.result).toBe('external')

    reads.holdNext()
    const deleted = new BackgroundTaskStore(reads.backend, () => 300)
    const doomed = deleted.list('s')
    await reads.held()
    await deleted.delete('s')
    reads.release()
    expect(await doomed).toEqual([])
    expect(await deleted.list('s')).toEqual([])
  })

  it('retries storage after a transient read failure instead of caching it as empty', async () => {
    const dir = tempDir()
    await seeded(dir, [{ task_id: 'bg1', kind: 'background_command', status: 'completed', result: 'the answer' }])
    const reads = controlledReads(testSessionDocuments(dir))
    const store = new BackgroundTaskStore(reads.backend, () => 200)
    reads.failNext()
    expect(await store.list('s')).toEqual([])
    expect((await store.get('s', 'bg1'))?.result).toBe('the answer')
  })

  it('caches successful reads, empty ones included, and keeps no read state after failure or supersession', async () => {
    const dir = tempDir()
    const reads = controlledReads(testSessionDocuments(dir))
    const store = new BackgroundTaskStore(reads.backend, () => 200)
    expect(await store.list('empty')).toEqual([])
    expect(await store.list('empty')).toEqual([])
    expect(reads.reads()).toBe(1)

    await seeded(dir, [{ task_id: 'bg1', kind: 'background_command', status: 'running' }])
    reads.failNext()
    await store.list('s')
    await store.list('s')
    await store.list('s')
    expect(reads.reads()).toBe(3)

    store.evict('s')
    reads.holdNext()
    const stale = store.list('s')
    await reads.held()
    store.evict('s')
    reads.release()
    await stale
    const settled = reads.reads()
    await store.list('s')
    expect(reads.reads()).toBe(settled)
  })
})
