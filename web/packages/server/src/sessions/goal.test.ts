import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  status: 'completed', messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: text }], final_response: text, error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false,
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
    expect(calls('goals.evaluate')).toEqual([expect.objectContaining({ session_id: sid, last_response: 'answer 1' }), expect.objectContaining({ session_id: sid, last_response: 'answer 2' })])
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
