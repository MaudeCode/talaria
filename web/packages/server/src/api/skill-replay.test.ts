import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import type { SidecarParams, SidecarResult, SkillReplayJob } from '@maudecode/talaria-web-contracts'

const servers: TestServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())) })

const BASELINE = 'a'.repeat(64)
const CANDIDATE = 'b'.repeat(64)
const FIXTURES = ['1'.repeat(64), '2'.repeat(64)]
const ROUTE = { provider: 'openrouter', model: 'vendor/model-a' }
const TRUSTED = { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', HERMES_WEBUI_GROUP_PROFILE_MAP: '{"ops":"work"}' }
const KIM = { 'X-Remote-User': 'kim' }

function plan(overrides: Partial<SidecarResult<'skills.replay_plan'>> = {}): SidecarResult<'skills.replay_plan'> {
  return {
    state: 'ready', reason: null, unavailable_cases: 0, route: ROUTE, max_output_tokens: 1500,
    revisions: [{ id: BASELINE, sha256: 'c'.repeat(64), label: 'cccccccccccc', role: 'baseline' }, { id: CANDIDATE, sha256: 'd'.repeat(64), label: 'dddddddddddd', role: 'candidate' }],
    cases: FIXTURES.map((id, i) => ({ id, case_id: `case-${String(i)}`, title: `Case ${String(i)}`, mode: 'plan' as const, input_tokens_bound: 2000 })),
    ...overrides,
  }
}

function answer(params: SidecarParams<'skills.replay_case'>, overrides: Partial<SidecarResult<'skills.replay_case'>> = {}): SidecarResult<'skills.replay_case'> {
  const passed = params.revision === CANDIDATE
  return { outcome: 'completed', error: null, finish_reason: 'tool_calls', provider: 'Vendor', content: 'api_key = synthetic-private-key-value', tool_calls: [{ name: 'send_email', arguments: '{}' }],
    input_tokens: 1200, output_tokens: 30, cost_usd: 0.0001, checks: { not_empty: true, expected_tools: passed }, passed, input_tokens_bound: 2000, ...overrides }
}

async function boot(sidecar: FakeSidecar, state?: string): Promise<TestServer> {
  const server = await bootTestServer({ sidecar, env: { ...TRUSTED, ...(state ? { HERMES_WEBUI_STATE_DIR: state, HERMES_HOME: state } : {}) } })
  servers.push(server)
  return server
}

const start = (s: TestServer, body: Record<string, unknown> = {}, headers: Record<string, string> = KIM) => s.get('/api/skills/replays', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ request_id: '6f1c2d3e-4b5a-4c6d-8e7f-001122334455', name: 'demo', baseline: BASELINE, candidate: CANDIDATE, case_ids: FIXTURES, route: ROUTE, max_cost_usd: 0.5, ...body }),
})
const list = async (s: TestServer, headers: Record<string, string> = KIM): Promise<SkillReplayJob[]> => {
  const response = await s.get('/api/skills/replays?name=demo', { headers })
  expect(response.status).toBe(200)
  return ((await response.json()) as { jobs: SkillReplayJob[] }).jobs
}
const cancel = (s: TestServer, id: string, headers: Record<string, string> = KIM) => s.get('/api/skills/replays/cancel', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id }) })
const settled = async (s: TestServer): Promise<SkillReplayJob> => vi.waitFor(async () => {
  const [job] = await list(s)
  if (!job || job.active) throw new Error('replay still active')
  return job
}, { timeout: 5000, interval: 20 })
const caseCalls = (sidecar: FakeSidecar) => sidecar.calls.filter((c) => c.method === 'skills.replay_case').map((c) => c.params as SidecarParams<'skills.replay_case'>)

it('plans with the reserved budget and stays unavailable without a backend', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('skills.replay_plan', () => plan())
  const s = await boot(sidecar)
  const body = await (await s.get(`/api/skills/replays/plan?name=demo&baseline=${BASELINE}&candidate=${CANDIDATE}`, { headers: KIM })).json() as { budget: unknown; cases: unknown[] }
  expect(body.budget).toEqual({ max_cost_usd: 0.5, max_calls: 4, max_output_tokens: 1500, max_input_tokens: 8000, max_price_per_million: 35.714285 })
  expect(caseCalls(sidecar)).toEqual([])
  sidecar.status = 'stopped'
  expect(await (await s.get(`/api/skills/replays/plan?name=demo&baseline=${BASELINE}&candidate=${CANDIDATE}`, { headers: KIM })).json()).toMatchObject({ state: 'unavailable', budget: null })
})

it('replays identical fixtures against both exact revisions once and retains redacted per-case results', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('skills.replay_plan', () => plan())
  sidecar.respond('skills.replay_case', (params) => answer(params))
  const s = await boot(sidecar)
  const response = await start(s)
  expect(response.status).toBe(200)
  const job = await settled(s)
  const calls = caseCalls(sidecar)
  expect(calls.map((c) => [c.fixture, c.revision])).toEqual([[FIXTURES[0], BASELINE], [FIXTURES[0], CANDIDATE], [FIXTURES[1], BASELINE], [FIXTURES[1], CANDIDATE]])
  expect(calls[0]).toMatchObject({ profile_home: s.deps.profileHome('default'), route: ROUTE, max_input_tokens: 2000, max_output_tokens: 1500, max_price_per_million: job.budget.max_price_per_million, sha256: 'c'.repeat(64) })
  expect(job).toMatchObject({ state: 'completed', active: false, can_cancel: false, reported_cost_usd: 0.0004, unreported_calls: 0 })
  expect(job.summary).toEqual([
    { role: 'baseline', passed: 0, failed: 2, error: 0, unknown: 0, refused: 0, skipped: 0, pending: 0 },
    { role: 'candidate', passed: 2, failed: 0, error: 0, unknown: 0, refused: 0, skipped: 0, pending: 0 },
  ])
  expect(job.cases[0]!.candidate.result?.tool_calls).toEqual([{ name: 'send_email', arguments: '{}' }])
  expect(JSON.stringify(job)).not.toContain('synthetic-private-key-value')
  expect(sidecar.calls.some((c) => c.method === 'aux.complete' || c.method === 'plugins.dashboard_request')).toBe(false)
})

it('admits a request id once, even after an uncertain acknowledgement, and refuses its reuse for another replay', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('skills.replay_plan', () => plan())
  sidecar.respond('skills.replay_case', (params) => answer(params))
  const s = await boot(sidecar)
  const [first, retry] = await Promise.all([start(s), start(s)])
  const ids = [((await first.json()) as SkillReplayJob).id, ((await retry.json()) as SkillReplayJob).id]
  expect(ids[0]).toBe(ids[1])
  await settled(s)
  expect(((await (await start(s)).json()) as SkillReplayJob).id).toBe(ids[0])
  expect(caseCalls(sidecar)).toHaveLength(4)
  expect(await list(s)).toHaveLength(1)
  const reused = await start(s, { case_ids: [FIXTURES[0]] })
  expect(reused.status).toBe(409)
  expect(caseCalls(sidecar)).toHaveLength(4)
})

it.each([
  ['route', { route: { provider: 'openrouter', model: 'vendor/model-b' } }],
  ['revision', { revisions: [plan().revisions[0]!, { ...plan().revisions[1]!, id: 'e'.repeat(64) }] }],
  ['case fixture', { cases: [{ ...plan().cases[0]!, id: '3'.repeat(64) }, plan().cases[1]!] }],
  ['unsupported route', { state: 'unavailable' as const, reason: 'route_unsupported' as const }],
  ['missing history', { state: 'unavailable' as const, reason: 'history_unavailable' as const, revisions: [], cases: [] }],
])('refuses %s drift after consent before any call', async (_name, overrides) => {
  const sidecar = new FakeSidecar()
  sidecar.respond('skills.replay_plan', () => plan(overrides))
  sidecar.respond('skills.replay_case', (params) => answer(params))
  const s = await boot(sidecar)
  const response = await start(s)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ condition: 'replay_drift' })
  expect(caseCalls(sidecar)).toEqual([])
  expect(await list(s)).toEqual([])
})

it('refuses stale or foreign revision identities and over-budget requests', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('skills.replay_plan', () => { throw new SidecarError('Revision no longer exists; reload history', { code: -32602, condition: 'invalid_params' }) })
  const s = await boot(sidecar)
  expect((await start(s)).status).toBe(400)
  expect((await start(s, { baseline: '../foreign' })).status).toBe(400)
  expect((await start(s, { max_cost_usd: 50 })).status).toBe(400)
  expect(caseCalls(sidecar)).toEqual([])
})

it('binds poll and cancel to the admitting owner and profile', async () => {
  const sidecar = new FakeSidecar()
  let release: () => void = () => undefined
  sidecar.respond('skills.replay_plan', () => plan())
  sidecar.respond('skills.replay_case', async (params) => { await new Promise<void>((resolve) => { release = resolve }); return answer(params) })
  const s = await boot(sidecar)
  const job = (await (await start(s)).json()) as SkillReplayJob
  await vi.waitFor(() => { expect(caseCalls(sidecar)).toHaveLength(1) })
  expect(await list(s, { 'X-Remote-User': 'lee' })).toEqual([])
  expect(await list(s, { ...KIM, 'X-Remote-Groups': 'ops' })).toEqual([])
  expect((await cancel(s, job.id, { 'X-Remote-User': 'lee' })).status).toBe(404)
  expect((await cancel(s, job.id, { ...KIM, 'X-Remote-Groups': 'ops' })).status).toBe(404)
  expect((await start(s, { request_id: '7f1c2d3e-4b5a-4c6d-8e7f-001122334455' })).status).toBe(409)
  const cancelling = (await (await cancel(s, job.id)).json()) as SkillReplayJob
  expect(cancelling).toMatchObject({ state: 'cancelling', active: true, can_cancel: false })
  release()
  const done = await settled(s)
  // The dispatched call reports its actual result; every successor is skipped and never sent.
  expect(done.state).toBe('cancelled')
  expect(done.cases[0]!.baseline.status).toBe('completed')
  expect([done.cases[0]!.candidate.status, done.cases[1]!.baseline.status, done.cases[1]!.candidate.status]).toEqual(['skipped', 'skipped', 'skipped'])
  expect(caseCalls(sidecar)).toHaveLength(1)
})

it('reconciles a restart without resending: the sent call is unknown and the rest are skipped', async () => {
  const state = mkdtempSync(join(tmpdir(), 'talaria-replay-restart-'))
  const before = new FakeSidecar()
  before.respond('skills.replay_plan', () => plan())
  before.respond('skills.replay_case', () => new Promise(() => undefined))
  const first = await boot(before, state)
  await start(first)
  await vi.waitFor(() => { expect(caseCalls(before)).toHaveLength(1) })
  servers.splice(servers.indexOf(first), 1)
  await first.close()
  const after = new FakeSidecar()
  after.respond('skills.replay_case', (params) => answer(params))
  const second = await boot(after, state)
  const [job] = await list(second)
  expect(job).toMatchObject({ state: 'interrupted', active: false })
  expect(job!.cases[0]!.baseline.status).toBe('unknown')
  expect(job!.summary[0]).toMatchObject({ unknown: 1, skipped: 1, pending: 0 })
  expect(caseCalls(after)).toEqual([])
  expect((await cancel(second, job!.id)).status).toBe(200)
  expect(caseCalls(after)).toEqual([])
})

it('stops successors when a call reports usage beyond its reservation', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('skills.replay_plan', () => plan())
  sidecar.respond('skills.replay_case', (params) => answer(params, { cost_usd: 1 }))
  const s = await boot(sidecar)
  await start(s)
  const job = await settled(s)
  expect(job).toMatchObject({ state: 'failed', reason: 'budget_exceeded' })
  expect(job.summary.map((row) => row.skipped)).toEqual([1, 2])
  expect(caseCalls(sidecar)).toHaveLength(1)
})

it('keeps refused, provider-error and unknown outcomes explicit', async () => {
  const sidecar = new FakeSidecar()
  let call = 0
  sidecar.respond('skills.replay_plan', () => plan())
  sidecar.respond('skills.replay_case', (params) => {
    call += 1
    if (call === 1) throw new SidecarError('Saved case changed; replay refused', { code: -32602, condition: 'invalid_params' })
    if (call === 2) throw new SidecarError('sidecar timed out', { condition: 'sidecar_timeout' })
    if (call === 3) throw new SidecarError('This provider route cannot enforce a replay budget', { condition: 'replay_refused' })
    if (call === 4) return answer(params, { outcome: 'unknown', error: 'TimeoutError', passed: null, checks: {}, cost_usd: null })
    if (call === 5) return answer(params, { outcome: 'error', error: 'Provider answered HTTP 402', passed: null, checks: {}, cost_usd: null })
    return answer(params)
  })
  sidecar.respond('skills.replay_plan', () => plan({ cases: [...plan().cases, { ...plan().cases[0]!, id: '3'.repeat(64), case_id: 'case-2' }] }))
  const s = await boot(sidecar)
  await start(s, { case_ids: [...FIXTURES, '3'.repeat(64)] })
  const job = await settled(s)
  expect(job.cases.flatMap((row) => [row.baseline.status, row.candidate.status])).toEqual(['refused', 'unknown', 'refused', 'unknown', 'error', 'completed'])
  expect(job).toMatchObject({ state: 'completed', unreported_calls: 3 })
  expect(job.summary.map((row) => row.passed + row.failed)).toEqual([0, 1])
})

it('never re-executes a request id whose results were pruned', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('skills.replay_plan', () => plan({ cases: [plan().cases[0]!] }))
  sidecar.respond('skills.replay_case', (params) => answer(params))
  const s = await boot(sidecar)
  const id = (i: number) => `6f1c2d3e-4b5a-4c6d-8e7f-${String(i).padStart(12, '0')}`
  for (let i = 0; i < 22; i += 1) {
    expect((await start(s, { request_id: id(i), case_ids: [FIXTURES[0]] })).status).toBe(200)
    await settled(s)
  }
  const sent = caseCalls(sidecar).length
  expect(sent).toBe(44)
  const retry = await start(s, { request_id: id(0), case_ids: [FIXTURES[0]] })
  expect(retry.status).toBe(409)
  expect(await retry.json()).toMatchObject({ condition: 'replay_pruned' })
  expect((await start(s, { request_id: id(0) })).status).toBe(409)
  expect(caseCalls(sidecar)).toHaveLength(sent)
}, 30_000)
