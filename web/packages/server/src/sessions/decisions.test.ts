import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DecisionReviewSchema, SIDECAR_SERVER_METHODS, type DecisionItemInput } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { Session } from './session.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { DecisionReviews, type StoredReview } from './decisions.js'
import { createStorage } from '../runtime.js'
import type { DocumentBackend } from './storage/backend.js'
import { decidedResultView, toolOutcome } from './merge.js'

type Method = 'server.decision_review_put' | 'server.decision_review_read' | 'server.decision_review_record'
const fixtures = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/decisions.json'), 'utf8')) as Record<Method, { params: Record<string, unknown>; result: unknown }[]>
const CALLER = '20261108_120000_caller'
const completed = { status: 'completed', messages: [], final_response: 'ok', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] } as never

const item = (id: string, extra: Partial<DecisionItemInput> = {}): DecisionItemInput => ({
  id, title: `Decision ${id}`, question: `Should ${id} change?`, explanation: 'Why it matters.', example: null, current: 'It stays as is.',
  recommendation: 'Keep it.', recommended_choice: 'keep', choices: [{ value: 'keep', label: 'Keep it', effect: 'Nothing changes.' }, { value: 'change', label: 'Change it', effect: 'It changes.' }],
  ...extra,
})

describe('decision reviews (TAL-1963)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let clock = 1_794_000_000
  const ask = async (method: Method, params: Record<string, unknown>, caller = CALLER) => {
    const reply = await sidecar.serverRequest(method, { caller_session_id: caller, ...params })
    return 'error' in reply ? reply : { result: SIDECAR_SERVER_METHODS[method].result.parse(reply.result) }
  }
  const result = (reply: unknown): unknown => (reply as { result: unknown }).result
  const condition = (reply: unknown) => (reply as { error?: { data?: { condition?: string } } }).error?.data?.condition
  const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await s.get(path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } } : { headers }) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  let documents: DocumentBackend
  /** Answer `itemId` as the user would: from the item as currently shown, unless `body` says otherwise. */
  const answer = async (id: string, itemId: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const shown = (await http('GET', `/api/decisions/${id}`)).body as { items?: { id: string; content_hash: string }[] }
    const content_hash = shown.items?.find((candidate) => candidate.id === itemId)?.content_hash ?? 'unknown'
    return http('PUT', `/api/decisions/${id}/answers/${itemId}`, { value: null, notes: '', deferred: false, custom: false, expected_version: 0, content_hash, ...body }, headers)
  }
  const stored = async (id: string) => (await documents.get('decision-reviews', id))?.value as StoredReview | undefined
  /** The id a create answered with. */
  const created = (reply: unknown): string => (reply as { result: { review_id: string } }).result.review_id
  const save = async (session_id: string, profile = 'default') => {
    const workspace = join(s.state, 'workspace')
    mkdirSync(workspace, { recursive: true })
    await s.deps.sessionStore.save(new Session({ session_id, title: session_id, profile, workspace, updated_at: clock, messages: [{ role: 'user', content: session_id, timestamp: clock }] }, { workspace, model: null }))
  }

  beforeEach(async () => {
    clock = 1_794_000_000
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, now: () => clock, storage: (config) => { const backend = createStorage(config, () => clock); documents = backend.documents; return backend } })
    await save(CALLER)
  })
  afterEach(async () => { await s.close() })

  it('records the server.decision_* fixtures from the real handlers', async () => {
    // The fixtures name the review `dr_0a1b2c3d`; this run's random id stands in for it.
    let id = 'dr_0a1b2c3d'
    const asRun = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('dr_0a1b2c3d', id)) as T
    for (const method of ['server.decision_review_put', 'server.decision_review_read', 'server.decision_review_record'] as const) {
      for (const [index, recorded] of fixtures[method].entries()) {
        // The read and record fixtures follow an answer and a submit by the user.
        if (method === 'server.decision_review_read' && index === 0) {
          await answer(id, 'retention', { value: 'shorter', notes: 'Disk is tight', deferred: false, custom: false, expected_version: 0 })
          sidecar.respond('chat.start', () => completed)
          clock += 60
          expect((await http('POST', `/api/decisions/${id}/submit`)).status).toBe(200)
        }
        clock += 60
        const reply = await ask(method, asRun(recorded.params), String(recorded.params.caller_session_id))
        if (method === 'server.decision_review_put' && index === 0) id = created(reply)
        expect(reply).toEqual({ result: asRun(recorded.result) })
      }
    }
  })

  it('creates a profile-scoped review, then revises it keeping answers, flagging changed items and keeping removed answers in history', async () => {
    const first = await ask('server.decision_review_put', { title: 'Release choices', intro: 'Three things to settle.', items: [item('a'), item('b'), item('c')] })
    const id = created(first)
    expect(id).toMatch(/^dr_[0-9a-f]{8}$/)
    expect(first).toEqual({ result: { review_id: id, url: `/decisions/${id}`, title: 'Release choices', status: 'open', progress: { total: 3, answered: 0, deferred: 0, needs_review: 0 } } })
    const fresh = DecisionReviewSchema.parse((await http('GET', `/api/decisions/${id}`)).body)
    expect(fresh).toMatchObject({ session_id: CALLER, profile: 'default', status: 'open', submit: { allowed: false, reason: 'nothing_answered' } })
    expect(fresh.items.map((i) => [i.id, i.fresh, i.needs_review, i.answer])).toEqual([['a', 'new', false, null], ['b', 'new', false, null], ['c', 'new', false, null]])
    expect(new Set(fresh.items.map((i) => i.content_hash)).size).toBe(3)

    for (const itemId of ['a', 'b', 'c']) await answer(id, itemId, { value: 'change' })
    const revised = await ask('server.decision_review_put', { review_id: id, title: 'Release choices', items: [item('a'), item('b', { question: 'Should b change now?' }), item('d')] })
    expect(result(revised)).toMatchObject({ review_id: id, status: 'open', progress: { total: 3, answered: 2, deferred: 0, needs_review: 1 } })
    const view = DecisionReviewSchema.parse((await http('GET', `/api/decisions/${id}`)).body)
    // New and changed items lead, each group in the agent's order.
    expect(view.items.map((i) => [i.id, i.fresh, i.needs_review, i.answer?.value ?? null])).toEqual([['b', 'changed', true, 'change'], ['d', 'new', false, null], ['a', 'carried', false, 'change']])
    const history = (await stored(id))!.history
    expect(history.filter((entry) => entry.kind === 'removed').map((entry) => entry.kind === 'removed' && [entry.item.id, entry.item.answer?.value])).toEqual([['c', 'change']])

    // Re-answering the changed item clears its review flag.
    const reanswered = await answer(id, 'b', { value: 'keep', notes: '', deferred: false, custom: false, expected_version: 1 })
    expect(DecisionReviewSchema.parse(reanswered.body).items.find((i) => i.id === 'b')).toMatchObject({ needs_review: false, answer: { value: 'keep', version: 2 } })

    // Another session cannot revise or read it.
    await save('20261108_120500_other')
    expect(condition(await ask('server.decision_review_read', { review_id: id }, '20261108_120500_other'))).toBe('review_unknown')
    expect(condition(await ask('server.decision_review_put', { review_id: id, title: 'x', items: [item('a')] }, '20261108_120500_other'))).toBe('review_unknown')
    expect(condition(await ask('server.decision_review_read', { review_id: id }, 'nosuchsession'))).toBe('caller_unknown')
  })

  it.each([
    ['no items', { items: [] }, 'items_count'],
    ['101 items', { items: Array.from({ length: 101 }, (_, i) => item(`i${i}`)) }, 'items_count'],
    ['one choice', { items: [item('a', { choices: [{ value: 'keep', label: 'Keep', effect: 'Same.' }] })] }, 'choices_count'],
    ['five choices', { items: [item('a', { choices: ['keep', 'b', 'c', 'd', 'e'].map((value) => ({ value, label: value, effect: value })) })] }, 'choices_count'],
    ['duplicate ids', { items: [item('a'), item('a')] }, 'duplicate_item_id'],
    ['duplicate values', { items: [item('a', { choices: [{ value: 'keep', label: 'Keep', effect: 'Same.' }, { value: 'keep', label: 'Also keep', effect: 'Same.' }] })] }, 'duplicate_choice_value'],
    ['an unknown recommendation', { items: [item('a', { recommended_choice: 'maybe' })] }, 'recommended_choice_unknown'],
    ['an over-long title', { title: 'x'.repeat(201), items: [item('a')] }, 'field_too_long'],
  ])('refuses a put with %s and writes nothing', async (_name, params, expected) => {
    expect(condition(await ask('server.decision_review_put', { title: 'Release choices', ...params }))).toBe(expected)
    expect(await documents.list('decision-reviews')).toEqual([])
    // A refused revision leaves the stored review as it was.
    const id = created(await ask('server.decision_review_put', { title: 'Release choices', items: [item('a')] }))
    const before = await stored(id)
    expect(condition(await ask('server.decision_review_put', { review_id: id, title: 'Release choices', ...params }))).toBe(expected)
    expect(await stored(id)).toEqual(before)
  })

  it('saves answers with their receipts and version, refusing a stale version with the stored answer', async () => {
    const id = created(await ask('server.decision_review_put', { title: 'Release choices', items: [item('a'), item('b'), item('c')] }))
    const answerA = (itemId: string, body: Record<string, unknown>) => answer(id, itemId, body)
    clock += 5
    const chosen = await answerA('a', { value: 'change', notes: '  Before Friday  ' })
    expect(chosen.status).toBe(200)
    expect(DecisionReviewSchema.parse(chosen.body).items.find((i) => i.id === 'a')!.answer).toEqual({ value: 'change', label: 'Change it', effect: 'It changes.', notes: 'Before Friday', deferred: false, custom: false, version: 1, updated_at: 1_794_000_005 })
    const deferred = DecisionReviewSchema.parse((await answerA('b', { deferred: true, notes: 'Ask ops' })).body)
    expect(deferred.items.find((i) => i.id === 'b')!.answer).toMatchObject({ value: null, label: null, effect: null, deferred: true, custom: false, notes: 'Ask ops' })
    const custom = DecisionReviewSchema.parse((await answerA('c', { custom: true, notes: 'Only on staging' })).body)
    expect(custom.items.find((i) => i.id === 'c')!.answer).toMatchObject({ value: null, deferred: false, custom: true, notes: 'Only on staging' })
    expect(custom.progress).toEqual({ total: 3, answered: 2, deferred: 1, needs_review: 0 })
    expect(custom.submit).toEqual({ allowed: true, reason: null })
    expect((await stored(id))!.history.map((entry) => entry.kind === 'answer' && [entry.item_id, entry.answer.question])).toEqual([['a', 'Should a change?'], ['b', 'Should b change?'], ['c', 'Should c change?']])

    const before = await stored(id)
    const stale = await answerA('a', { value: 'keep', expected_version: 0 })
    expect(stale).toEqual({ status: 409, body: { error: 'This answer changed since it was loaded.', code: 'answer_conflict', answer: { value: 'change', label: 'Change it', effect: 'It changes.', notes: 'Before Friday', deferred: false, custom: false, version: 1, updated_at: 1_794_000_005 } } })
    expect(await stored(id)).toEqual(before)
    expect((await answerA('a', { value: 'nope', expected_version: 1 })).body.code).toBe('invalid_answer')
    expect((await answerA('c', { custom: true, notes: '  ', expected_version: 1 })).body.code).toBe('invalid_answer')
    expect((await answerA('zz', { value: 'keep' })).status).toBe(404)
    expect(DecisionReviewSchema.parse((await answerA('a', { value: 'keep', expected_version: 1 })).body).items.find((i) => i.id === 'a')!.answer).toMatchObject({ value: 'keep', version: 2 })
  })

  it('refuses an answer given to content the agent has since revised, storing nothing', async () => {
    const id = created(await ask('server.decision_review_put', { title: 'Release choices', items: [item('a')] }))
    const shown = DecisionReviewSchema.parse((await http('GET', `/api/decisions/${id}`)).body).items[0]!.content_hash
    // The agent keeps the value `change` but makes it mean something else while the user's form is open.
    await ask('server.decision_review_put', { review_id: id, title: 'Release choices', items: [item('a', { choices: [{ value: 'keep', label: 'Keep it', effect: 'Nothing changes.' }, { value: 'change', label: 'Delete it', effect: 'It is deleted.' }] })] })
    const before = await stored(id)
    const stale = await answer(id, 'a', { value: 'change', content_hash: shown })
    expect(stale).toMatchObject({ status: 409, body: { code: 'item_changed', answer: null } })
    expect(await stored(id)).toEqual(before)
    expect((await answer(id, 'a', { value: 'change' })).status).toBe(200)
  })

  it('drops an outcome when its answer changes, so the new answer must be recorded before the review is applied', async () => {
    sidecar.respond('chat.start', () => completed)
    const id = created(await ask('server.decision_review_put', { title: 'Release choices', items: [item('a')] }))
    await answer(id, 'a', { value: 'keep' })
    await http('POST', `/api/decisions/${id}/submit`)
    await ask('server.decision_review_record', { review_id: id, outcomes: [{ id: 'a', state: 'kept' }] })
    // The agent adds a decision, the user changes the carried answer and resubmits.
    await ask('server.decision_review_put', { review_id: id, title: 'Release choices', items: [item('a'), item('b')] })
    const changed = DecisionReviewSchema.parse((await answer(id, 'a', { value: 'change', expected_version: 1 })).body)
    expect(changed.items.find((i) => i.id === 'a')!.outcome).toBeNull()
    await answer(id, 'b', { value: 'keep' })
    await http('POST', `/api/decisions/${id}/submit`)
    const partial = DecisionReviewSchema.parse(result(await ask('server.decision_review_record', { review_id: id, outcomes: [{ id: 'b', state: 'applied' }] })))
    expect(partial.status).toBe('submitted')
  })

  it('submits by messaging the owning session once: an idle session starts a turn, a running one gets a steer', async () => {
    // The first submit's turn runs until the end of the test, so the second submit steers it.
    let finish: () => void = () => undefined
    sidecar.respond('chat.start', () => new Promise((resolve) => { finish = () => { resolve(completed) } }))
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null, can_redirect: true }))
    const emitted = vi.spyOn(s.deps.channels, 'emit')
    const id = created(await ask('server.decision_review_put', { title: 'Release\nchoices', items: [item('a')] }))
    expect(await http('POST', `/api/decisions/${id}/submit`)).toMatchObject({ status: 400, body: { code: 'nothing_answered' } })
    await answer(id, 'a', { value: 'keep', notes: '', deferred: false, custom: false, expected_version: 0 })
    const submitted = await http('POST', `/api/decisions/${id}/submit`)
    expect(submitted.status).toBe(200)
    expect(DecisionReviewSchema.parse(submitted.body)).toMatchObject({ status: 'submitted', submitted_at: clock, submit: { allowed: false, reason: 'not_open' } })
    expect(emitted).toHaveBeenLastCalledWith(CALLER, 'decision_review', { session_id: CALLER, review_id: id, status: 'submitted', progress: { total: 1, answered: 1, deferred: 0, needs_review: 0 } }, 'default')
    const starts = () => sidecar.calls.filter((call) => call.method === 'chat.start')
    await vi.waitFor(() => { expect(starts()).toHaveLength(1) })
    const message = (starts()[0]!.params as { user_message: string }).user_message
    expect(message).toBe(`The decision review "Release choices" (${id}) was submitted. Call decision_review_read with review_id ${id} for the answers.`)
    expect(message).not.toContain('\n')
    expect((await http('POST', `/api/decisions/${id}/submit`)).body.code).toBe('review_closed')
    expect((await answer(id, 'a', { value: 'change', notes: '', deferred: false, custom: false, expected_version: 1 })).body.code).toBe('review_closed')

    // The turn that submit started is still running: the next submit steers it.
    expect(s.deps.registry.activeRunStreamForSession(CALLER)).toBeTruthy()
    const followUp = created(await ask('server.decision_review_put', { title: 'Follow-up', items: [item('b')] }))
    await answer(followUp, 'b', { value: 'change', notes: '', deferred: false, custom: false, expected_version: 0 })
    expect((await http('POST', `/api/decisions/${followUp}/submit`)).status).toBe(200)
    await vi.waitFor(() => { expect(sidecar.calls.filter((call) => call.method === 'chat.steer').map((call) => (call.params as { text: string }).text)).toEqual([expect.stringContaining(`(${followUp})`)]) })
    expect(starts()).toHaveLength(1)
    finish()
    await s.deps.turns.finished(s.deps.registry.activeRunStreamForSession(CALLER)!)
  })

  it('reopens a review whose submit message the session refused', async () => {
    const id = created(await ask('server.decision_review_put', { title: 'Release choices', items: [item('a')] }))
    await answer(id, 'a', { value: 'keep', notes: '', deferred: false, custom: false, expected_version: 0 })
    // The session became read-only (an import) after the agent made the review: the start is refused.
    const row = await s.deps.sessionStore.get(CALLER)
    row.read_only = true
    await s.deps.sessionStore.save(row)
    const refused = await http('POST', `/api/decisions/${id}/submit`)
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect((await stored(id))!.status).toBe('open')
    expect(s.deps.decisions.openCount(CALLER)).toBe(1)
  })

  it('reads answers as the user saw them after the choices changed, and records outcomes all or nothing', async () => {
    sidecar.respond('chat.start', () => completed)
    const id = created(await ask('server.decision_review_put', { title: 'Release choices', items: [item('a'), item('b'), item('c')] }))
    await answer(id, 'a', { value: 'change', notes: '', deferred: false, custom: false, expected_version: 0 })
    await answer(id, 'b', { value: null, notes: '', deferred: true, custom: false, expected_version: 0 })
    await ask('server.decision_review_put', { review_id: id, title: 'Release choices', items: [item('a', { choices: [{ value: 'keep', label: 'Leave it', effect: 'No change.' }, { value: 'change', label: 'Switch', effect: 'Switches over.' }] }), item('b'), item('c')] })
    const read = DecisionReviewSchema.parse(result(await ask('server.decision_review_read', { review_id: id })))
    expect(read.items.find((i) => i.id === 'a')).toMatchObject({ needs_review: true, answer: { value: 'change', label: 'Change it', effect: 'It changes.' } })

    await answer(id, 'a', { value: 'change', notes: '', deferred: false, custom: false, expected_version: 1 })
    await http('POST', `/api/decisions/${id}/submit`)
    const before = await stored(id)
    expect(condition(await ask('server.decision_review_record', { review_id: id, outcomes: [{ id: 'a', state: 'applied' }, { id: 'zz', state: 'kept' }] }))).toBe('unknown_item')
    expect(await stored(id)).toEqual(before)
    // Only answered items gate `applied`; the deferred one does not.
    const recorded = DecisionReviewSchema.parse(result(await ask('server.decision_review_record', { review_id: id, outcomes: [{ id: 'a', state: 'applied', note: 'Switched in config.yaml' }] })))
    expect(recorded.status).toBe('applied')
    expect(recorded.items.find((i) => i.id === 'a')!.outcome).toEqual({ state: 'applied', note: 'Switched in config.yaml' })
    expect(recorded.items.find((i) => i.id === 'b')!.outcome).toBeNull()
  })

  it('reports an open review as decision attention below approvals and clarify, publishing sessions_changed when it changes', async () => {
    const row = async () => ((await http('GET', '/api/sessions')).body.sessions as { session_id: string; attention: unknown }[]).find((r) => r.session_id === CALLER)?.attention
    const published = vi.spyOn(s.deps.events, 'publish')
    expect(await row()).toBeNull()
    const id = created(await ask('server.decision_review_put', { title: 'Release choices', items: [item('a')] }))
    expect(published).toHaveBeenCalledWith('decision_review', { profile: 'default', sessionId: CALLER })
    expect(await row()).toEqual({ kind: 'decision', count: 1, severity: 'question' })
    s.deps.pending.submitClarify(CALLER, { question: 'Which branch?', choices: ['main'] })
    expect(await row()).toMatchObject({ kind: 'clarify', severity: 'question' })
    s.deps.pending.submitApproval(CALLER, { command: 'rm -rf build', description: 'delete build output' })
    expect(await row()).toMatchObject({ kind: 'approval', severity: 'critical' })

    published.mockClear()
    await answer(id, 'a', { value: 'keep', notes: '', deferred: false, custom: false, expected_version: 0 })
    expect(published).not.toHaveBeenCalled()
    await http('POST', `/api/decisions/${id}/cancel`)
    expect(published).toHaveBeenCalledWith('decision_review', { profile: 'default', sessionId: CALLER })
    expect(s.deps.decisions.openCount(CALLER)).toBe(0)
  })

  it('deletes a session\'s reviews with the session', async () => {
    sidecar.respond('state_db.delete_cli_session', () => ({ ok: true, deleted_ids: [CALLER] }))
    const id = created(await ask('server.decision_review_put', { title: 'Release choices', items: [item('a')] }))
    await save('20261108_120500_other')
    const kept = created(await ask('server.decision_review_put', { title: 'Other choices', items: [item('a')] }, '20261108_120500_other'))
    expect((await http('POST', '/api/session/delete', { session_id: CALLER })).status).toBe(200)
    expect((await http('GET', `/api/decisions/${id}`)).status).toBe(404)
    expect(await stored(id)).toBeUndefined()
    expect(s.deps.decisions.openCount(CALLER)).toBe(0)
    expect(((await http('GET', '/api/decisions')).body.reviews as { review_id: string }[]).map((review) => review.review_id)).toEqual([kept])
  })

  it('keeps the open index across a restart', async () => {
    await ask('server.decision_review_put', { title: 'Release choices', items: [item('a')] })
    const reloaded = new DecisionReviews(documents, () => s.deps, () => clock)
    await reloaded.initialize()
    expect(reloaded.openCount(CALLER)).toBe(1)
  })

  it('shows a review only to its own profile', async () => {
    mkdirSync(join(s.state, 'profiles', 'other'), { recursive: true })
    const id = created(await ask('server.decision_review_put', { title: 'Release choices', items: [item('a')] }))
    expect((await http('GET', '/api/decisions')).body.reviews).toHaveLength(1)
    const other = { cookie: 'hermes_profile=other' }
    expect((await http('GET', `/api/decisions/${id}`, undefined, other)).status).toBe(404)
    expect((await http('GET', '/api/decisions', undefined, other)).body).toEqual({ reviews: [] })
    expect((await answer(id, 'a', { value: 'keep', notes: '', deferred: false, custom: false, expected_version: 0 }, other)).status).toBe(404)
    expect((await http('GET', '/api/decisions/dr_nothere')).status).toBe(404)
  })

  it('links the transcript card from a live and a replayed decision_review_put result', () => {
    const recorded = fixtures['server.decision_review_put'][0]!.result as { review_id: string; title: string; progress: unknown }
    const ref = { review_id: recorded.review_id, title: recorded.title, progress: recorded.progress }
    const live = toolOutcome(JSON.stringify(recorded), 'decision_review_put')
    expect(live.result_view.decision_review).toEqual(ref)
    expect(decidedResultView(live.result_view as Record<string, unknown>).decision_review).toEqual(ref)
    expect(toolOutcome(JSON.stringify(recorded), 'other_tool').result_view.decision_review).toBeUndefined()
    expect(toolOutcome(JSON.stringify({ error: 'refused', condition: 'items_count' }), 'decision_review_put').result_view.decision_review).toBeUndefined()
  })
})
