import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SidecarParams, SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'
import { str } from '../util.js'

type Json = Record<string, unknown>
type Decision = SidecarResult<'goals.evaluate'>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

const GOAL = 'Ship the release notes'
const state = { goal: GOAL, status: 'active', turns_used: 0, max_turns: 20, last_verdict: null, last_reason: null, paused_reason: null }
const answer = (params: SidecarParams<'chat.start'>, text: string): SidecarResult<'chat.start'> => ({
  status: 'completed', messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: text }], final_response: text, error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
  usage: { prompt_tokens: 10, completion_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
  agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
})
const continueWith = (prompt: string): Decision => ({ status: 'active', should_continue: true, continuation_prompt: prompt, verdict: 'continue', reason: 'more to do', message: '↻ Continuing toward goal (1/20): more to do', message_key: 'goal_continuing', message_args: [1, 20, 'more to do'] })
const achieved: Decision = { status: 'done', should_continue: false, continuation_prompt: null, verdict: 'done', reason: 'notes shipped', message: '✓ Goal achieved: notes shipped', message_key: 'goal_achieved', message_args: ['notes shipped'] }
const inactive: Decision = { status: null, should_continue: false, continuation_prompt: null, verdict: 'inactive', reason: 'no active goal', message: '' }
const goalFrames = (frames: SseFrame[]): [string, Json][] => frames.filter((f) => f.event === 'goal' || f.event === 'goal_continue').map((f) => [f.event, f.data as Json])

describe('/goal continuation after a goal turn settles (TAL-396)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())
  beforeEach(() => {
    sidecar.calls.length = 0
    sidecar.respond('goals.snapshot', () => ({ goal: null, snapshot: null }))
    sidecar.respond('goals.command', (params) => ({ ok: true, action: 'set', message: `⊙ Goal set: ${params.args}`, goal: { ...state, goal: params.args }, kickoff_prompt: params.args }))
    sidecar.respond('goals.evaluate', () => inactive)
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Release notes"', usage: null }))
  })

  const newSession = async (): Promise<string> => str(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
  const setGoal = async (sid: string): Promise<string> => {
    const res = await post(s, '/api/goal', { session_id: sid, args: GOAL })
    expect(res.status).toBe(200)
    return str((await json(res)).stream_id)
  }
  const untilEnd = (streamId: string): Promise<SseFrame[]> => s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
  const calls = (method: string): Json[] => sidecar.calls.filter((c) => c.method === method).map((c) => c.params as Json)
  const idle = async (sid: string): Promise<void> => {
    await vi.waitFor(() => { expect(((s.deps.sessionStore.get(sid)).active_stream_id)).toBeNull() })
  }

  it('evaluates each goal turn, starts the continuation the Agent asks for, and stops when the goal is done', async () => {
    const sid = await newSession()
    let turn = 0
    sidecar.respond('chat.start', (params) => answer(params, `answer ${String(++turn)}`))
    const decisions = [continueWith('Continue toward the goal.'), achieved]
    sidecar.respond('goals.evaluate', () => decisions.shift() ?? achieved)

    const kickoff = await setGoal(sid)
    const first = goalFrames(await untilEnd(kickoff))
    expect(first.map(([event, data]) => [event, data.state])).toEqual([['goal', 'evaluating'], ['goal', 'continuing'], ['goal_continue', 'continuing']])
    expect(first[1]?.[1]).toMatchObject({ session_id: sid, decision: 'continue', message_key: 'goal_continuing', message_args: [1, 20, 'more to do'] })
    const next = first[2]![1]
    expect(next).toMatchObject({ session_id: sid, continuation_prompt: 'Continue toward the goal.', text: 'Continue toward the goal.' })
    const continuation = str(next.stream_id)
    expect(continuation).toMatch(/^[0-9a-f]{32}$/)
    expect(continuation).not.toBe(kickoff)

    const second = goalFrames(await untilEnd(continuation))
    expect(second.map(([event, data]) => [event, data.state])).toEqual([['goal', 'evaluating'], ['goal', 'idle']])
    expect(second[1]?.[1]).toMatchObject({ decision: 'done', message: '✓ Goal achieved: notes shipped', message_key: 'goal_achieved' })
    await idle(sid)
    expect(calls('chat.start').map((p) => str(p.user_message).split('\n').pop())).toEqual([GOAL, 'Continue toward the goal.'])
    // TAL-882: the Agent runs goal gates in the session's workspace.
    const workspace = s.deps.sessionStore.get(sid).workspace
    expect(workspace).toBeTruthy()
    expect(calls('goals.command')).toEqual([expect.objectContaining({ session_id: sid, args: GOAL, workspace })])
    expect(calls('goals.evaluate')).toEqual([expect.objectContaining({ session_id: sid, last_response: 'answer 1', workspace }), expect.objectContaining({ session_id: sid, last_response: 'answer 2', workspace })])
  })

  it.each([true, false])('admits a goal continuation after workspace deletion (TAL-729, fallback available: %s)', async (recoverable) => {
    const sid = await newSession()
    const session = s.deps.sessionStore.get(sid)
    const fallback = session.workspace
    const worktree = join(fallback, 'goal-worktree')
    mkdirSync(worktree, { recursive: true })
    session.workspace = worktree
    s.deps.sessionStore.save(session)
    sidecar.respond('chat.start', (params) => answer(params, 'progress'))
    let evaluations = 0
    sidecar.respond('goals.evaluate', () => {
      if (++evaluations > 1) return achieved
      rmSync(recoverable ? worktree : fallback, { recursive: true })
      return continueWith('Continue toward the goal.')
    })
    try {
      const frames = goalFrames(await untilEnd(await setGoal(sid)))
      expect(calls('chat.start')[0]?.workspace).toBe(worktree)
      if (recoverable) {
        const next = frames.find(([event]) => event === 'goal_continue')?.[1]
        expect(next).toBeDefined()
        await untilEnd(str(next?.stream_id))
        expect(calls('chat.start')[1]).toMatchObject({ workspace: fallback, user_message: 'Continue toward the goal.' })
        expect(s.deps.sessionStore.get(sid).workspace).toBe(fallback)
      } else {
        expect(frames.at(-1)).toEqual(['goal', expect.objectContaining({ state: 'idle', decision: 'error' })])
        expect(calls('chat.start')).toHaveLength(1)
        expect(s.logs.some((line) => line.includes(`goal continuation for ${sid} not started (400)`))).toBe(true)
      }
      await idle(sid)
    } finally {
      mkdirSync(fallback, { recursive: true })
    }
  })

  it.each(['qualified', 'stale'] as const)('resolves a %s model before a goal continuation (TAL-729)', async (kind) => {
    const sid = await newSession()
    sidecar.respond('chat.start', (params) => ({ ...answer(params, 'progress'), model: params.model ?? 'test-model', provider: params.model_provider ?? 'test' }))
    if (kind === 'stale') {
      const config = { model: { provider: 'openai-codex', default: 'gpt-5.5', api_key: 'sk-test-key-123456' } }
      sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config }))
      sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
      sidecar.respond('plugins.providers', () => ({ providers: [] }))
      sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: [] }))
      writeFileSync(join(s.state, 'config.yaml'), '# synthetic model config\n')
      s.deps.agentConfig.invalidate()
      s.deps.catalog.invalidate()
      await s.deps.catalog.warmSessionModelRepair(s.state)
    }
    let evaluations = 0
    sidecar.respond('goals.evaluate', () => {
      if (++evaluations > 1) return achieved
      const session = s.deps.sessionStore.get(sid)
      session.model = kind === 'qualified' ? '@gemini:gemini-3.1-pro-preview' : 'gemini-3.1-pro-preview'
      session.model_provider = null
      s.deps.sessionStore.save(session)
      return continueWith('Continue toward the goal.')
    })
    const frames = goalFrames(await untilEnd(await setGoal(sid)))
    const next = frames.find(([event]) => event === 'goal_continue')?.[1]
    expect(next).toBeDefined()
    await untilEnd(str(next?.stream_id))
    await idle(sid)
    const expected = kind === 'qualified'
      ? { model: 'gemini-3.1-pro-preview', model_provider: 'gemini' }
      : { model: 'gpt-5.5', model_provider: 'openai-codex' }
    expect(calls('chat.start')[1]).toMatchObject(expected)
    expect(s.deps.sessionStore.get(sid)).toMatchObject(expected)
  })

  it('stops when the turn budget is spent or the goal was paused', async () => {
    const budget: Decision = { status: 'paused', should_continue: false, continuation_prompt: null, verdict: 'continue', reason: 'not yet', message: '⏸ Goal paused — 20/20 turns used.', message_key: 'goal_paused_budget_exhausted', message_args: [20, 20] }
    const paused: Decision = { status: 'paused', should_continue: false, continuation_prompt: null, verdict: 'inactive', reason: 'no active goal', message: '' }
    for (const decision of [budget, paused]) {
      sidecar.calls.length = 0
      const sid = await newSession()
      sidecar.respond('chat.start', (params) => answer(params, 'progress'))
      sidecar.respond('goals.evaluate', () => decision)
      const frames = goalFrames(await untilEnd(await setGoal(sid)))
      expect(frames.map(([event, data]) => [event, data.state, data.decision])).toEqual([['goal', 'evaluating', undefined], ['goal', 'idle', decision.verdict]])
      await idle(sid)
      expect(calls('chat.start')).toHaveLength(1)
    }
  })

  it('a stopped goal turn is not evaluated and starts nothing', async () => {
    const sid = await newSession()
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'working' } })
      opts.signal?.addEventListener('abort', () => { resolve({ ...answer(params, ''), status: 'cancelled' }) })
    }))
    sidecar.respond('goals.evaluate', () => continueWith('Continue toward the goal.'))
    const kickoff = await setGoal(sid)
    await s.sse(`/api/chat/stream?stream_id=${kickoff}`, (f) => f.event === 'token')
    expect(await json(await s.get(`/api/chat/cancel?stream_id=${kickoff}`))).toMatchObject({ cancelled: true })
    const frames = await s.sse(`/api/chat/stream?stream_id=${kickoff}&after_event_id=${kickoff}:0`, (f) => f.event === 'cancel')
    expect(goalFrames(frames)).toEqual([])
    await idle(sid)
    expect(calls('goals.evaluate')).toEqual([])
    expect(calls('chat.start')).toHaveLength(1)
  })

  it('a Stop after the answer while the goal is judged starts no continuation until the next user message (TAL-899)', async () => {
    const sid = await newSession()
    sidecar.respond('chat.start', (params) => answer(params, 'progress'))
    let release: () => void = () => undefined
    sidecar.respond('goals.evaluate', () => new Promise((resolve) => { release = () => { resolve(continueWith('Continue toward the goal.')) } }))
    const kickoff = await setGoal(sid)
    await vi.waitFor(() => { expect(calls('goals.evaluate')).toHaveLength(1) })
    expect(await json(await s.get(`/api/chat/cancel?stream_id=${kickoff}`))).toMatchObject({ cancelled: false })
    release()
    const frames = goalFrames(await untilEnd(kickoff))
    expect(frames.map(([event, data]) => [event, data.state, data.decision])).toEqual([['goal', 'evaluating', undefined], ['goal', 'idle', 'held']])
    await idle(sid)
    expect(calls('chat.start')).toHaveLength(1)
    const session = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect(session.automatic_turns_held).toBe(true)

    sidecar.respond('goals.evaluate', () => achieved)
    const user = str((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'keep going' }))).stream_id)
    await untilEnd(user)
    await idle(sid)
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).automatic_turns_held).toBe(false)
  })

  it('a late Stop for a turn the user already followed holds nothing (TAL-899)', async () => {
    const sid = await newSession()
    sidecar.respond('chat.start', (params) => answer(params, 'progress'))
    let release: () => void = () => undefined
    let evaluations = 0
    sidecar.respond('goals.evaluate', () => {
      if (++evaluations > 1) return achieved
      return new Promise((resolve) => { release = () => { resolve(continueWith('Continue toward the goal.')) } })
    })
    const kickoff = await setGoal(sid)
    await vi.waitFor(() => { expect(evaluations).toBe(1) })
    const user = str((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'keep going' }))).stream_id)
    expect(await json(await s.get(`/api/chat/cancel?stream_id=${kickoff}`))).toMatchObject({ cancelled: false })
    expect(s.deps.turns.automaticTurnsHeld(sid)).toBe(false)
    release()
    await untilEnd(kickoff)
    await untilEnd(user)
    await idle(sid)
    expect(s.deps.turns.automaticTurnsHeld(sid)).toBe(false)
  })

  it('a failed evaluation or failed turn ends the goal run without a continuation, and a turn without a goal shows nothing', async () => {
    const sid = await newSession()
    sidecar.respond('chat.start', (params) => answer(params, 'progress'))
    sidecar.respond('goals.evaluate', () => { throw new SidecarError('judge exploded', { condition: 'sidecar_error' }) })
    const frames = goalFrames(await untilEnd(await setGoal(sid)))
    expect(frames.map(([event, data]) => [event, data.state, data.decision])).toEqual([['goal', 'evaluating', undefined], ['goal', 'idle', 'error']])
    await idle(sid)
    expect(calls('chat.start')).toHaveLength(1)

    sidecar.calls.length = 0
    sidecar.respond('goals.evaluate', () => continueWith('Continue toward the goal.'))
    sidecar.respond('chat.start', (params) => ({ ...answer(params, ''), status: 'error', error: 'provider down', messages: [{ role: 'user', content: str(params.user_message) }] }))
    const failed = await untilEnd(await setGoal(sid))
    expect(failed.some((f) => f.event === 'apperror')).toBe(true)
    expect(goalFrames(failed)).toEqual([])

    sidecar.calls.length = 0
    sidecar.respond('goals.evaluate', () => inactive)
    sidecar.respond('chat.start', (params) => answer(params, 'plain'))
    const plain = str((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'unrelated question' }))).stream_id)
    expect(goalFrames(await untilEnd(plain))).toEqual([])
    await idle(sid)
    expect(calls('goals.evaluate')).toEqual([expect.objectContaining({ session_id: sid, last_response: 'plain' })])
    expect(calls('chat.start')).toHaveLength(1)

    sidecar.respond('goals.evaluate', () => { throw new SidecarError('goals unavailable', { condition: 'goals_unavailable' }) })
    expect(goalFrames(await untilEnd(str((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'another question' }))).stream_id)))).toEqual([])
  })

  it('ships the standing goal on the session view and as `session_goal`, from set through park, pause and clear (TAL-808)', async () => {
    const sid = await newSession()
    type GoalStatus = SidecarResult<'goals.get'>
    const status = (goal: Json | null, parked: GoalStatus['parked'] = null): GoalStatus => ({ goal: goal as GoalStatus['goal'], active: goal?.status === 'active', parked, message: '' })
    let current = status(null)
    sidecar.respond('goals.get', () => current)
    const detailGoal = async (): Promise<unknown> => ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).goal
    const shown = (fields: Json): Json => ({ text: GOAL, status: 'active', turns_used: 0, max_turns: 20, reason: null, parked_until: null, ...fields })
    const goalEvents = (frames: SseFrame[]): unknown[] => frames.filter((f) => f.event === 'session_goal').map((f) => (f.data as Json).goal)
    sidecar.respond('chat.start', (params) => answer(params, 'progress'))
    // A goal the Agent already holds shows on the session's first load.
    current = status(state)
    expect(await detailGoal()).toEqual(shown({}))

    // Each judgement re-reads it: a counted turn, then a timed park with its reason and deadline.
    const until = Date.now() / 1000 + 600
    const decisions = [continueWith('Continue toward the goal.'), { ...inactive, status: 'active', verdict: 'wait', reason: 'CI running', message: '⏳ Goal parked' }]
    sidecar.respond('goals.evaluate', () => {
      const decision = decisions.shift()!
      current = decision.verdict === 'wait' ? status({ ...state, turns_used: 2 }, { reason: 'CI running', until }) : status({ ...state, turns_used: 1 })
      return decision
    })
    const first = await untilEnd(await setGoal(sid))
    expect(goalEvents(first)).toEqual([shown({ turns_used: 1 })])
    expect(first.findIndex((f) => f.event === 'session_goal')).toBeLessThan(first.findIndex((f) => f.event === 'goal_continue'))
    const next = str(goalFrames(first).find(([event]) => event === 'goal_continue')?.[1].stream_id)
    const parked = shown({ status: 'parked', turns_used: 2, reason: 'CI running', parked_until: until })
    expect(goalEvents(await untilEnd(next))).toEqual([parked])
    await idle(sid)
    expect(await detailGoal()).toEqual(parked)

    // `/goal pause` and `/goal clear` change it before the client reloads the session.
    const command = async (args: string, after: GoalStatus): Promise<void> => {
      sidecar.respond('goals.command', () => { current = after; return { ok: true, action: args, message: args, goal: after.goal } })
      expect((await post(s, '/api/goal', { session_id: sid, args })).status).toBe(200)
    }
    await command('pause', status({ ...state, turns_used: 2, status: 'paused', paused_reason: 'user paused' }))
    expect(await detailGoal()).toEqual(shown({ status: 'paused', turns_used: 2, reason: 'user paused' }))
    await command('clear', status({ ...state, status: 'cleared' }))
    expect(await detailGoal()).toBeNull()
  })

  it('drops a done goal from the session view once the judge says so (TAL-808)', async () => {
    const sid = await newSession()
    let current: SidecarResult<'goals.get'> = { goal: state, active: true, parked: null, message: '' }
    sidecar.respond('goals.get', () => current)
    sidecar.respond('chat.start', (params) => answer(params, 'shipped'))
    sidecar.respond('goals.evaluate', () => { current = { goal: { ...state, status: 'done', turns_used: 1 }, active: false, parked: null, message: '' }; return achieved })
    const frames = await untilEnd(await setGoal(sid))
    expect(frames.filter((f) => f.event === 'session_goal').map((f) => (f.data as Json).goal)).toEqual([null])
    await idle(sid)
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).goal).toBeNull()
  })

  it('a resumed or persisted goal continues from the next user message', async () => {
    const sid = await newSession()
    let turn = 0
    sidecar.respond('chat.start', (params) => answer(params, `answer ${String(++turn)}`))
    const decisions = [continueWith('Continue toward the goal.'), achieved]
    sidecar.respond('goals.evaluate', () => decisions.shift() ?? inactive)
    const user = str((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'continue' }))).stream_id)
    const first = goalFrames(await untilEnd(user))
    expect(first.map(([event, data]) => [event, data.state])).toEqual([['goal', 'continuing'], ['goal_continue', 'continuing']])
    const second = goalFrames(await untilEnd(str(first[1]![1].stream_id)))
    expect(second.map(([event, data]) => [event, data.state, data.decision])).toEqual([['goal', 'evaluating', undefined], ['goal', 'idle', 'done']])
    await idle(sid)
    expect(calls('chat.start').map((p) => str(p.user_message).split('\n').pop())).toEqual(['continue', 'Continue toward the goal.'])
  })

  // TAL-622: a client that waits for the drain signal before deleting learns which run still holds the session.
  const status = async (streamId: string): Promise<Json> => json(await s.get(`/api/chat/stream/status?stream_id=${streamId}`))
  const remove = async (sid: string): Promise<number> => (await post(s, '/api/session/delete', { session_id: sid })).status

  it('stream status names the goal continuation that took the session, and the delete waits for it', async () => {
    const sid = await newSession()
    let releaseContinuation: () => void = () => undefined
    sidecar.respond('chat.start', (params) => {
      if (!str(params.user_message).endsWith('Continue toward the goal.')) return answer(params, 'first answer')
      return new Promise((resolve) => { releaseContinuation = () => { resolve(answer(params, 'second answer')) } })
    })
    const decisions = [continueWith('Continue toward the goal.'), achieved]
    sidecar.respond('goals.evaluate', () => decisions.shift() ?? inactive)
    const first = str((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'talaria contract fixture' }))).stream_id)
    await vi.waitFor(async () => { expect((await status(first)).active).toBe(false) })
    const continuation = s.deps.sessionStore.get(sid).active_stream_id
    expect(continuation).not.toBe(first)
    expect((await status(first)).blocking_stream_id).toBe(continuation)
    expect(await remove(sid)).toBe(409)
    releaseContinuation()
    await vi.waitFor(async () => { expect((await status(first)).blocking_stream_id).toBeNull() })
    expect(await remove(sid)).toBe(200)
  })

  it('stream status names a stopped run that is still unwinding, and the delete waits for it', async () => {
    const sid = await newSession()
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    let unwind: () => void = () => undefined
    // The Agent ignores the interrupt until released, like a tool call that has not returned yet.
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'working' } })
      unwind = () => { resolve({ ...answer(params, ''), status: 'cancelled' }) }
    }))
    const streamId = str((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'long task' }))).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
    expect(await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).toMatchObject({ cancelled: true })
    expect(await status(streamId)).toMatchObject({ active: false, blocking_stream_id: streamId })
    expect(await remove(sid)).toBe(409)
    unwind()
    await vi.waitFor(async () => { expect((await status(streamId)).blocking_stream_id).toBeNull() })
    expect(await remove(sid)).toBe(200)
  })

  it('a user message sent while the goal is judged runs first and is evaluated as the goal turn', async () => {
    const sid = await newSession()
    sidecar.respond('chat.start', (params) => answer(params, `re: ${str(params.user_message).split('\n').pop() ?? ''}`))
    let release: () => void = () => undefined
    let evaluations = 0
    sidecar.respond('goals.evaluate', () => {
      evaluations += 1
      if (evaluations > 1) return achieved
      return new Promise((resolve) => { release = () => { resolve(continueWith('Continue toward the goal.')) } })
    })
    const kickoff = await setGoal(sid)
    await vi.waitFor(() => { expect(evaluations).toBe(1) })
    let userTurn = ''
    sidecar.respond('chat.start', (params, _emit, opts) => new Promise((resolve) => {
      opts.signal?.addEventListener('abort', () => { resolve({ ...answer(params, ''), status: 'cancelled' }) })
      userTurn = str(params.user_message)
      setTimeout(() => { resolve(answer(params, 'user answer')) }, 100)
    }))
    const user = await post(s, '/api/chat/start', { session_id: sid, message: 'also add a changelog' })
    expect(user.status).toBe(200)
    const userStream = str((await json(user)).stream_id)
    release()
    const first = goalFrames(await untilEnd(kickoff))
    expect(first.map(([event, data]) => [event, data.state])).toEqual([['goal', 'evaluating'], ['goal', 'continuing']])
    const second = goalFrames(await untilEnd(userStream))
    expect(second.map(([event, data]) => [event, data.state, data.decision])).toEqual([['goal', 'evaluating', undefined], ['goal', 'idle', 'done']])
    await idle(sid)
    expect(userTurn.endsWith('also add a changelog')).toBe(true)
    expect(calls('chat.start')).toHaveLength(2)
    expect(calls('goals.evaluate').map((p) => p.last_response)).toEqual([`re: ${GOAL}`, 'user answer'])
  })
})
