import type { GatewaySessionParams, GatewaySessionResult, SideLaunch } from '@maudecode/talaria-web-contracts'
import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestServer } from '../test/harness.js'
import type { FakeSidecar } from '../sidecar/fake.js'
import type { StreamFrame } from '../sidecar/client.js'
import { attached, bootOwnerAttachment, fixture, sid, snapshot } from '../test/gateway-owner.js'
import { openStateDb } from '../test/harness.js'

describe('native side launches (TAL-1340)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  let emit: (frame: Omit<StreamFrame, 'seq'>) => void
  let reply: SideLaunch
  let running: boolean
  let disconnect: () => void
  beforeEach(async () => {
    ({ s, db, sidecar } = await bootOwnerAttachment())
    reply = { state: 'accepted', task_id: 'bg-native' }
    running = false
    sidecar.respond('gateway.session', (params, send, opts) => {
      const snap = snapshot({ running })
      if (params.action === 'watch') {
        emit = send
        send({ event: 'snapshot', data: attached(snap) })
        return new Promise((resolve) => {
          disconnect = () => { resolve({ state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null }) }
          opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true })
        })
      }
      if (params.action.startsWith('launch_')) return { ...attached(snap), launch: reply }
      return attached(snap)
    })
  })
  afterEach(async () => { db.close(); await s.close() })
  const post = (kind: 'background' | 'btw') => s.get(`/api/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid, ...(kind === 'btw' ? { question: 'What does this mean?' } : { prompt: 'Check the logs' }) }) })
  const complete = (kind: string, text: string, stamps: Record<string, unknown> = {}) => { emit({ event: 'event', data: { type: `${kind}.complete`, session_id: sid, replay_epoch: 'owner-epoch', authority_epoch: 1, seq: 5, payload: { task_id: 'bg-native', text }, ...stamps } }) }
  const tasks = async () => (await (await s.get(`/api/background/tasks?session_id=${sid}`)).json() as { tasks: { task_id: string; status: string; launch_state?: string }[] }).tasks

  it.each([['background', false], ['background', true], ['btw', false], ['btw', true]] as const)('launches %s without a local session or parent turn, running=%s', async (kind, isRunning) => {
    running = isRunning
    const created = vi.spyOn(s.deps.sessionStore, 'newSession')
    const saved = vi.spyOn(s.deps.sessionStore, 'save')
    const response = await post(kind)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = await response.json() as { stream_id: string; task_id: string; launch: { state: string } }
    expect(body.launch).toEqual({ state: 'accepted', task_id: body.task_id })
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toHaveLength(0)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action === 'submit')).toHaveLength(0)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action.startsWith('launch_')).map((c) => c.params)).toEqual([
      expect.objectContaining({ action: `launch_${kind}`, session_id: sid, profile_home: s.deps.profileHome('default'), text: kind === 'btw' ? 'What does this mean?' : 'Check the logs', authority_epoch: 1 }),
    ])
    expect(created).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
    expect(await s.deps.background.receipts(sid)).toEqual([])
    const read = s.sse(`/api/chat/stream?stream_id=${body.stream_id}`, (f) => f.event === 'stream_end')
    complete(kind, 'Owner result')
    complete(kind, 'duplicate')
    const frames = await read
    expect(frames.filter((f) => f.event === 'done').map((f) => f.data)).toEqual([expect.objectContaining({ answer: 'Owner result' })])
    if (kind === 'background') {
      const tasks = await (await s.get(`/api/background/tasks?session_id=${sid}`)).json() as { tasks: { task_id: string; status: string; title: string }[] }
      expect(tasks.tasks.filter((t) => t.title === 'Check the logs')).toEqual([expect.objectContaining({ task_id: body.task_id, status: 'completed' })])
      expect(await (await s.get(`/api/background/result?session_id=${sid}&task_id=${body.task_id}`)).json()).toMatchObject({ text: 'Owner result', launch_state: 'accepted' })
    }
  })

  it.each(['failed', 'unsupported', 'unknown'] as const)('preserves a %s launch verdict without fallback or resend', async (state) => {
    reply = { state, task_id: null }
    const response = await post('background')
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ launch: { state, task_id: null } })
    expect(await tasks()).toEqual(state === 'unknown' ? [expect.objectContaining({ status: 'unknown', launch_state: 'unknown' })] : [])
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action.startsWith('launch_'))).toHaveLength(1)
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toHaveLength(0)
  })

  it('refuses a snapshot for another parent before dispatching any launch', async () => {
    sidecar.respond('gateway.session', () => attached(snapshot({ session_id: fixture.sessions.tui! })))
    const response = await post('background')
    expect(response.status).toBe(409)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session').map((c) => (c.params as GatewaySessionParams).action)).toEqual(['snapshot'])
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toHaveLength(0)
  })

  it('keeps native work invalidation for a background completion launched outside Web', async () => {
    const controller = new AbortController()
    const viewer = await s.deps.sessions.owner!.observe(sid, 'default', controller.signal)
    const subscription = s.deps.events.subscribe()
    try {
      emit({ event: 'event', data: { type: 'background.complete', session_id: sid, authority_epoch: 1, replay_epoch: 'owner-epoch', seq: 5, payload: { task_id: 'bg-other-client', text: 'Other work finished' } } })
      const noWait = new AbortController()
      noWait.abort()
      expect(await subscription.next(noWait.signal)).toEqual(expect.objectContaining({ reason: 'background_task', session_id: sid }))
      expect(await tasks()).toEqual([])
    } finally { subscription.close(); controller.abort(); viewer?.release() }
  })

  it('ignores completion from another owner epoch and bounds and redacts the accepted result', async () => {
    const response = await post('background')
    expect(response.status, await response.clone().text()).toBe(200)
    const { task_id: taskId } = await response.json() as { task_id: string }
    complete('background', 'old owner', { replay_epoch: 'old' })
    complete('background', 'OPENAI_API_KEY=sk-synthetic-launch-secret-1234567890abcdef\n' + 'x'.repeat(100_000))
    await vi.waitFor(async () => {
      const result = await s.get(`/api/background/result?session_id=${sid}&task_id=${taskId}`)
      expect(result.status).toBe(200)
      const body = await result.text()
      expect(body).not.toContain('sk-synthetic')
      expect(body).not.toContain('old owner')
      expect(body.length).toBeLessThan(66_000)
    })
  })

  it('keeps one pending row while the receipt is held, and adopts an early completion without opening a second observation', async () => {
    let entered!: () => void
    const dispatched = new Promise<void>((resolve) => { entered = resolve })
    let acknowledge!: (result: GatewaySessionResult) => void
    const receipt = new Promise<GatewaySessionResult>((resolve) => { acknowledge = resolve })
    const original = sidecar.responderFor('gateway.session')!
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'launch_background') { entered(); return receipt }
      return original(params, send, opts)
    })
    const request = post('background')
    try {
      await Promise.race([dispatched, request.then(async (response) => { throw new Error(`Launch ended before dispatch: ${response.status} ${await response.text()}`) })])
      expect(await tasks()).toEqual([expect.objectContaining({ status: 'running', launch_state: 'pending' })])
      complete('background', 'Finished before the reply')
      acknowledge({ ...attached(snapshot()), launch: reply })
      const response = await request
      expect(response.status).toBe(200)
      await vi.waitFor(async () => { expect(await tasks()).toEqual([expect.objectContaining({ status: 'completed', launch_state: 'accepted' })]) })
      expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action === 'watch')).toHaveLength(1)
    } finally {
      acknowledge({ ...attached(snapshot()), launch: reply })
      await request.catch(() => undefined)
    }
  })

  it.each(['disconnect', 'replay gap'])('keeps a launch unknown after %s and reconciles its matching replay without resending', async (failure) => {
    const response = await post('background')
    expect(response.status).toBe(200)
    if (failure === 'disconnect') disconnect()
    else emit({ event: 'snapshot', data: { ...attached(snapshot()), replay_gap: true } })
    await vi.waitFor(async () => { expect(await tasks()).toEqual([expect.objectContaining({ status: 'unknown', launch_state: 'unknown' })]) })
    const controller = new AbortController()
    const viewer = await s.deps.sessions.owner!.observe(sid, 'default', controller.signal)
    try {
      complete('background', 'Recovered result')
      await vi.waitFor(async () => { expect(await tasks()).toEqual([expect.objectContaining({ status: 'completed', launch_state: 'accepted' })]) })
      expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action === 'launch_background')).toHaveLength(1)
    } finally { controller.abort(); viewer?.release() }
  })

  it('retires accepted work as unknown on owner replacement and never adopts a new owner\'s same task id', async () => {
    const response = await post('background')
    expect(response.status).toBe(200)
    emit({ event: 'snapshot', data: attached(snapshot({ authority_epoch: 2, replay_epoch: 'new-owner' })) })
    complete('background', 'Unrelated result', { authority_epoch: 2, replay_epoch: 'new-owner', seq: 9 })
    await vi.waitFor(async () => { expect(await tasks()).toEqual([expect.objectContaining({ status: 'unknown', launch_state: 'unknown' })]) })
    const { task_id: taskId } = await response.json() as { task_id: string }
    expect((await s.get(`/api/background/result?session_id=${sid}&task_id=${taskId}`)).status).toBe(404)
  })

  it('keeps results and dismissal scoped to the parent and profile even for identical session ids', async () => {
    const response = await post('background')
    expect(response.status).toBe(200)
    const { task_id: taskId } = await response.json() as { task_id: string }
    complete('background', 'Profile-private result')
    await vi.waitFor(async () => { expect(await tasks()).toEqual([expect.objectContaining({ status: 'completed' })]) })
    const profileDb = join(s.state, 'profiles', 'work', 'state.db')
    mkdirSync(join(profileDb, '..'), { recursive: true })
    const other = openStateDb(profileDb)
    try {
      other.exec(fixture.schema.join('\n'))
      for (const sql of fixture.inserts) other.exec(sql)
      const headers = { cookie: 'hermes_profile=work' }
      expect(await (await s.get(`/api/background/tasks?session_id=${sid}`, { headers })).json()).toMatchObject({ tasks: [] })
      expect((await s.get(`/api/background/result?session_id=${sid}&task_id=${taskId}`, { headers })).status).toBe(404)
      expect((await s.get(`/api/background/result?session_id=${fixture.sessions.tui!}&task_id=${taskId}`)).status).toBe(404)
      expect((await s.get('/api/background/dismiss', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid, task_id: taskId }) })).status).toBe(404)
      expect((await s.get('/api/background/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid, task_id: taskId }) })).status).toBe(200)
      expect(await tasks()).toEqual([expect.objectContaining({ status: 'completed', pinned: false })])
    } finally { other.close() }
  })
})
