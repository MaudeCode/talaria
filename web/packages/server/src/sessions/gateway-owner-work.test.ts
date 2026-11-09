/**
 * TAL-1336: a native-owner chat's processes and subagents in Background Work, read and controlled only through the owner
 * that runs them. A synthetic owner answers the sidecar's work actions; no live provider or process is involved.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTask, GatewaySessionParams, GatewaySessionResult, OwnerWork } from '@maudecode/talaria-web-contracts'
import type { TestServer } from '../test/harness.js'
import { openStateDb } from '../test/harness.js'
import type { FakeSidecar } from '../sidecar/fake.js'
import { attached, bootOwnerAttachment, fixture, ownerHelpers, sid, snapshot } from '../test/gateway-owner.js'

const native = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/web-native-work.json', import.meta.url), 'utf8')) as {
  work: OwnerWork; owner: { 'subagent.tail': Record<string, NonNullable<GatewaySessionResult['work_tail']>> }
}
const otherSid = fixture.sessions.tui!
const bare = { reason: null, snapshot: null, receipt: null }
type Roster = OwnerWork | 'unsupported' | 'lost'

describe('native owner background work (TAL-1336)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  let roster: Roster
  let control: (params: GatewaySessionParams) => GatewaySessionResult
  beforeEach(async () => {
    ({ s, db, sidecar } = await bootOwnerAttachment())
    roster = native.work
    control = (params) => ({ state: 'attached', ...bare, work_outcome: params.action === 'work_steer' ? 'queued' : 'stopped' })
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'work_list') {
        if (roster === 'unsupported') return { state: 'refused', ...bare, reason: 'unsupported_projection' }
        if (roster === 'lost') return { state: 'unavailable', ...bare, reason: 'owner_connection_lost' }
        return { state: 'attached', ...bare, work: roster }
      }
      if (params.action === 'work_tail') return { state: 'attached', ...bare, work_tail: native.owner['subagent.tail'][params.work_id!]! }
      if (params.action === 'work_stop' || params.action === 'work_steer') return control(params)
      return attached(snapshot({ session_id: params.session_id, stored_session_id: params.session_id }))
    })
  })
  afterEach(async () => { db.close(); await s.close() })
  const { post } = ownerHelpers(() => ({ s, sidecar }))

  const read = async (session = sid, profile = 'default') => {
    const response = await s.get(`/api/background/tasks?session_id=${session}`, { headers: { cookie: `hermes_profile=${profile}` } })
    expect(response.status, await response.clone().text()).toBe(200)
    return await response.json() as { tasks: BackgroundTask[]; owner_work?: string; agents_working?: boolean }
  }
  const task = async (title: string, session = sid, profile = 'default') => {
    const found = (await read(session, profile)).tasks.find((t) => t.title === title)
    expect(found, title).toBeDefined()
    return found!
  }
  const ownerCalls = (action: string) => sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action === action).map((c) => c.params as GatewaySessionParams)
  const stop = (taskId: string, session = sid, profile = 'default') => s.get('/api/background/stop', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `hermes_profile=${profile}` }, body: JSON.stringify({ session_id: session, task_id: taskId }) })
  const directStops = () => sidecar.calls.filter((c) => c.method === 'process.stop')

  it('lists resident and rebuilt subagents and the session\'s processes with the actions their owner permits', async () => {
    const body = await read()
    expect(body.owner_work).toBe('available')
    expect(body.agents_working).toBe(true)
    const byTitle = Object.fromEntries(body.tasks.map((t) => [t.title, t]))
    expect(byTitle['npm run dev']).toMatchObject({ kind: 'process', status: 'running', can_stop: true, result_available: true, pinned: true, active: true })
    expect(byTitle['npm run dev']!.can_steer ?? false).toBe(false)
    expect(byTitle['make build']).toMatchObject({ kind: 'process', status: 'completed', exit_code: 0, can_stop: false, active: false })
    expect(byTitle['Read the logs']).toMatchObject({ kind: 'delegation', status: 'running', can_stop: true, can_steer: true, result_available: true })
    // A parent rebuilt since dispatch keeps its child readable, never controllable.
    expect(byTitle['Check the tests']).toMatchObject({ kind: 'delegation', status: 'running', can_stop: false, can_steer: false, result_available: false })
    // Ids are opaque: no native process or subagent id leaks into a client identity.
    for (const t of body.tasks) expect(t.task_id).not.toMatch(/proc_|sa-/)
    expect(ownerCalls('watch')).toHaveLength(0)

    const result = async (taskId: string) => s.get(`/api/background/result?session_id=${sid}&task_id=${encodeURIComponent(taskId)}`)
    expect(await (await result(byTitle['npm run dev']!.task_id)).json()).toMatchObject({ text: 'listening on 5173\n' })
    expect(ownerCalls('work_tail')).toHaveLength(0)
    expect(await (await result(byTitle['Read the logs']!.task_id)).json()).toMatchObject({ text: 'read_file logs/app.log\n' })
    expect(ownerCalls('work_tail')).toEqual([expect.objectContaining({ work_kind: 'subagent', work_id: 'sa-resident', authority_epoch: 1 })])
    expect((await result(byTitle['Check the tests']!.task_id)).status).toBe(404)
    expect(ownerCalls('work_tail')).toHaveLength(1)
  })

  it('redacts owner commands, goals, output and tails while controls keep the native identity', async () => {
    const secret = 'sk-synthetic-owner-work-secret-1234567890abcdef'
    roster = { ...native.work, processes: native.work.processes.map((p) => ({ ...p, command: `OPENAI_API_KEY=${secret} npm run dev`, output_tail: `token ${secret}\n` })),
      subagents: native.work.subagents.map((a) => ({ ...a, goal: `Use OPENAI_API_KEY=${secret}` })) }
    sidecar.respond('gateway.session', (params) => params.action === 'work_list' ? { state: 'attached', ...bare, work: roster as OwnerWork }
      : params.action === 'work_tail' ? { state: 'attached', ...bare, work_tail: { available: true, text: `OPENAI_API_KEY=${secret}`, truncated: false } }
      : params.action === 'work_stop' ? { state: 'attached', ...bare, work_outcome: 'stopped' } : attached(snapshot()))
    const listed = await (await s.get(`/api/background/tasks?session_id=${sid}`)).text()
    expect(listed).not.toContain(secret)
    const tasks = (JSON.parse(listed) as { tasks: BackgroundTask[] }).tasks
    for (const t of tasks.filter((t) => t.result_available)) {
      expect(await (await s.get(`/api/background/result?session_id=${sid}&task_id=${encodeURIComponent(t.task_id)}`)).text()).not.toContain(secret)
    }
    const server = tasks.find((t) => t.kind === 'process' && t.can_stop)!
    expect(await (await stop(server.task_id)).json()).toEqual({ outcome: 'stopped' })
    expect(ownerCalls('work_stop')).toEqual([expect.objectContaining({ work_kind: 'process', work_id: 'proc_server' })])
  })

  it('stops exactly one native row through its owner and never the sidecar\'s own registry', async () => {
    const server = await task('npm run dev')
    expect(await (await stop(server.task_id)).json()).toEqual({ outcome: 'stopped' })
    const child = await task('Read the logs')
    expect(await (await stop(child.task_id)).json()).toEqual({ outcome: 'stopped' })
    expect(ownerCalls('work_stop')).toEqual([
      expect.objectContaining({ work_kind: 'process', work_id: 'proc_server', authority_epoch: 1 }),
      expect.objectContaining({ work_kind: 'subagent', work_id: 'sa-resident', authority_epoch: 1 }),
    ])
    // A finished process and a rebuilt parent's child send nothing.
    expect(await (await stop((await task('make build')).task_id)).json()).toEqual({ outcome: 'not_running' })
    expect(await (await stop((await task('Check the tests')).task_id)).json()).toEqual({ outcome: 'not_running' })
    // The owner no longer finds the child: its own answer, not a success.
    control = () => ({ state: 'attached', ...bare, work_outcome: 'not_found' })
    expect(await (await stop(child.task_id)).json()).toEqual({ outcome: 'not_found' })
    expect(ownerCalls('work_stop')).toHaveLength(3)
    expect(directStops()).toHaveLength(0)
  })

  it('steers a resident child with the owner\'s queued or refused verdict and never sends to one that cannot take it', async () => {
    const steer = (taskId: string, text = 'Look at stderr too') => post('/api/background/steer', { session_id: sid, task_id: taskId, text })
    const child = await task('Read the logs')
    expect(await (await steer(child.task_id)).json()).toEqual({ outcome: 'queued' })
    control = () => ({ state: 'attached', ...bare, work_outcome: 'rejected' })
    expect(await (await steer(child.task_id)).json()).toEqual({ outcome: 'rejected' })
    expect(ownerCalls('work_steer')).toEqual([
      expect.objectContaining({ work_kind: 'subagent', work_id: 'sa-resident', text: 'Look at stderr too', authority_epoch: 1 }),
      expect.objectContaining({ work_kind: 'subagent', work_id: 'sa-resident', text: 'Look at stderr too' }),
    ])
    expect(await (await steer((await task('Check the tests')).task_id)).json()).toEqual({ outcome: 'rejected' })
    expect(await (await steer((await task('npm run dev')).task_id)).json()).toEqual({ outcome: 'rejected' })
    expect((await steer(child.task_id, '   ')).status).toBe(400)
    expect(ownerCalls('work_steer')).toHaveLength(2)
  })

  it('fences every id to its owner epoch, session and profile', async () => {
    const server = await task('npm run dev')
    const elsewhere = await task('npm run dev', otherSid)
    expect(elsewhere.task_id).not.toBe(server.task_id)
    expect(await (await stop(server.task_id, otherSid)).json()).toEqual({ outcome: 'not_found' })

    const otherPath = join(s.state, 'profiles', 'work', 'state.db')
    mkdirSync(join(otherPath, '..'), { recursive: true })
    const other = openStateDb(otherPath)
    try {
      other.exec(fixture.schema.join('\n'))
      for (const sql of fixture.inserts) other.exec(sql)
      const work = await task('npm run dev', sid, 'work')
      expect(work.task_id).not.toBe(server.task_id)
      expect(await (await stop(server.task_id, sid, 'work')).json()).toEqual({ outcome: 'not_found' })
    } finally { other.close() }

    // The owner restarted: the same native process id under a new authority is another row.
    roster = { ...native.work, authority_epoch: 2 }
    expect(await (await stop(server.task_id)).json()).toEqual({ outcome: 'not_found' })
    expect(ownerCalls('work_stop')).toHaveLength(0)
    // A restart between the read and the stop: the owner refuses the old authority, and nothing was stopped.
    control = () => ({ state: 'refused', ...bare, reason: 'owner_changed' })
    expect(await (await stop((await task('npm run dev')).task_id)).json()).toEqual({ outcome: 'not_found' })
    expect(ownerCalls('work_stop')).toEqual([expect.objectContaining({ work_id: 'proc_server', authority_epoch: 2 })])
    expect(directStops()).toHaveLength(0)
  })

  it('reports a managed worker as unsupported and an unreachable owner as unavailable, listing and stopping nothing', async () => {
    const server = await task('npm run dev')
    roster = 'unsupported'
    const unsupported = await read()
    expect(unsupported.owner_work).toBe('unsupported')
    expect(unsupported.tasks.filter((t) => t.kind === 'process' || t.kind === 'delegation')).toEqual([])
    expect(await (await stop(server.task_id)).json()).toEqual({ outcome: 'not_found' })
    roster = 'lost'
    expect((await read()).owner_work).toBe('unavailable')
    expect(ownerCalls('work_stop')).toHaveLength(0)
    expect(directStops()).toHaveLength(0)
  })

  it('never replays a stop whose outcome was lost, and settles the row from the owner', async () => {
    const server = await task('npm run dev')
    control = () => ({ state: 'unavailable', ...bare, reason: 'owner_connection_lost' })
    const response = await stop(server.task_id)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ outcome_unknown: true })
    expect(ownerCalls('work_stop')).toHaveLength(1)
    // The owner's roster is the only authority on what happened.
    roster = { ...native.work, processes: native.work.processes.map((p) => p.process_id === 'proc_server' ? { ...p, running: false, exited_at: 1700000100, completion_reason: 'killed', exit_code: -15 } : p) }
    expect(await task('npm run dev')).toMatchObject({ task_id: server.task_id, status: 'cancelled', can_stop: false, active: false })
    expect(ownerCalls('work_stop')).toHaveLength(1)
    expect(directStops()).toHaveLength(0)
  })

  it('announces owner work changes through an open observation without opening one', async () => {
    const { observeOwner } = ownerHelpers(() => ({ s, sidecar }))
    const published = vi.spyOn(s.deps.events, 'publish')
    await read()
    expect(ownerCalls('watch')).toHaveLength(0)
    const watch = await observeOwner(snapshot({ running: true, pending: [] }))
    try {
      published.mockClear()
      watch.event('subagent.complete', { subagent_id: 'sa-resident', status: 'completed' })
      await vi.waitFor(() => { expect(published).toHaveBeenCalledWith('background_task', expect.objectContaining({ sessionId: sid })) })
    } finally { watch.finish(); await watch.read }
  })
})
