import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { AUTO_PRUNE_KIND, AUTO_PRUNE_WINDOW_S } from './prune-advice.js'

type Json = Record<string, unknown>
const LINES = [
  'Low disk space: 1.0 GB free of 100.0 GB. Your session history (state.db) uses 3.0 GB.',
  'Auto-prune is off. Turning it on deletes ended sessions inactive for more than 90 days, once a day (pinned and open sessions are kept).',
  '/autoprune on to enable, /autoprune off to keep everything (never asked again), /autoprune later to be reminded in a week.',
]
const REPLY = 'Auto-prune is off and you will not be asked again. `hermes sessions prune` still works any time.'

const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) { await s.close(); rmSync(s.state, { recursive: true, force: true }) } })

/** A server whose fake Agent asks in every `low` home and records each `/autoprune` it runs. */
async function boot(options: { saves?: boolean } = {}) {
  let clock = 1_000_000
  const low = new Set<string>()
  const commands: { home: string; command: string }[] = []
  const sidecar = new FakeSidecar()
  const s = await bootTestServer({ sidecar, now: () => clock })
  servers.push(s)
  sidecar.respond('state_db.prune_advice', (params) => ({ advice: low.has(params.profile_home) ? { lines: LINES } : null }))
  sidecar.respond('commands.exec', (params) => {
    commands.push({ home: params.profile_home, command: params.command })
    if (options.saves !== false) low.delete(params.profile_home)
    return { output: options.saves === false ? 'Could not save sessions.auto_prune; check disk space and config.yaml permissions.' : REPLY, source: 'agent' as const }
  })
  const adviceCalls = () => sidecar.calls.filter((call) => call.method === 'state_db.prune_advice').length
  const questions = async (): Promise<Json[]> => ((await (await s.get('/api/update-notifications')).json()) as { notifications: Json[] }).notifications.filter((row) => row.kind === AUTO_PRUNE_KIND)
  const post = (path: string, body: unknown) => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return { s, low, commands, adviceCalls, questions, post, tick: (seconds: number) => { clock += seconds } }
}

describe('auto-prune question (TAL-1274)', () => {
  it('asks each profile once per window and answers with the Agent\'s /autoprune', async () => {
    const t = await boot()
    const root = t.s.state
    const work = join(root, 'profiles', 'work')
    mkdirSync(work, { recursive: true })
    t.low.add(root)
    t.low.add(work)

    await t.s.deps.pruneAdvice.sweep()
    expect(t.adviceCalls()).toBe(2)
    // The active (root) profile sees only its own question, worded by the Agent, with the three answers.
    const [question, ...others] = await t.questions()
    expect(others).toEqual([])
    expect(question).toMatchObject({
      title: 'Session auto-prune', message: `${LINES[0]} ${LINES[1]}`, detail: LINES[2], phase: 'awaiting_confirmation', severity: 'warning',
      requires_interaction: true, can_dismiss: false, actions: [{ id: 'autoprune_on' }, { id: 'autoprune_off' }, { id: 'autoprune_later' }],
    })

    // Within the window nothing is checked again; past it the open question is refreshed in place, never duplicated.
    t.tick(AUTO_PRUNE_WINDOW_S - 1)
    await t.s.deps.pruneAdvice.sweep()
    expect(t.adviceCalls()).toBe(2)
    t.tick(1)
    await t.s.deps.pruneAdvice.sweep()
    expect(t.adviceCalls()).toBe(4)
    expect((await t.questions()).map((row) => row.id)).toEqual([question?.id])

    const res = await t.post(`/api/update-notifications/${String(question?.id)}/actions/autoprune_off`, { perform: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: question?.id, phase: 'succeeded', message: REPLY, detail: null, actions: [], requires_interaction: false, can_dismiss: true })
    expect(t.commands).toEqual([{ home: root, command: '/autoprune off' }])

    // Answered: the next window asks only the profile still undecided, which the root never sees.
    t.tick(AUTO_PRUNE_WINDOW_S)
    await t.s.deps.pruneAdvice.sweep()
    expect((await t.questions()).map((row) => row.phase)).toEqual(['succeeded'])
  })

  it('checks a profile only under its write lease, so a profile being deleted never gets a question', async () => {
    const t = await boot()
    const work = join(t.s.state, 'profiles', 'work')
    mkdirSync(work, { recursive: true })
    t.low.add(t.s.state)
    t.low.add(work)
    const held: string[] = []
    let released = 0
    const beginWrite = t.s.deps.profiles.beginWrite.bind(t.s.deps.profiles)
    t.s.deps.profiles.beginWrite = async (name) => {
      if (name === 'work') return 'deleting'
      const release = await beginWrite(name)
      if (typeof release !== 'function') return release
      held.push(name)
      return () => { released += 1; release() }
    }
    await t.s.deps.pruneAdvice.sweep()
    expect(held).toEqual(['default'])
    expect(released).toBe(1)
    // The profile under deletion was never read, and is retried on the next sweep rather than marked checked.
    expect(t.adviceCalls()).toBe(1)
    t.s.deps.profiles.beginWrite = beginWrite
    await t.s.deps.pruneAdvice.sweep()
    expect(t.adviceCalls()).toBe(2)
  })

  it('publishes nothing when the Agent does not ask, including Agents before v0.22.3', async () => {
    const t = await boot()
    await t.s.deps.pruneAdvice.sweep()
    expect(t.adviceCalls()).toBe(1)
    expect(await t.questions()).toEqual([])
  })

  it('keeps the question open when the Agent could not save the answer', async () => {
    const t = await boot({ saves: false })
    t.low.add(t.s.state)
    await t.s.deps.pruneAdvice.sweep()
    const [question] = await t.questions()
    const res = await t.post(`/api/update-notifications/${String(question?.id)}/actions/autoprune_on`, { perform: true })
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('Could not save sessions.auto_prune')
    expect(await t.questions()).toMatchObject([{ id: question?.id, phase: 'awaiting_confirmation', requires_interaction: true }])
  })

  it('withdraws the open question once /autoprune answers it from the composer', async () => {
    const t = await boot()
    t.low.add(t.s.state)
    await t.s.deps.pruneAdvice.sweep()
    expect(await t.questions()).toHaveLength(1)
    const res = await t.post('/api/commands/exec', { command: '/autoprune later' })
    expect(res.status).toBe(200)
    expect(t.commands).toEqual([{ home: t.s.state, command: '/autoprune later' }])
    expect(await t.questions()).toEqual([])
  })
})
