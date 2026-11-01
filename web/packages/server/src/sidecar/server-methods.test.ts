import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RPC_ERROR_CODES, SIDECAR_SERVER_METHODS } from '@maudecode/talaria-web-contracts'
import { SidecarClient } from './client.js'
import { FakeSidecar } from './fake.js'
import { answerSidecarRequest, SidecarServerError } from './server-methods.js'
import { Session } from '../sessions/session.js'
import { bootTestServer } from '../test/harness.js'

const fixtures = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar')
const recorded = (JSON.parse(readFileSync(join(fixtures, 'server.json'), 'utf8')) as Record<string, { params: Record<string, unknown>; result: unknown }[]>)['server.session_list']![0]!

describe('sidecar-originated server requests (TAL-1164)', () => {
  let client: SidecarClient | null = null
  afterEach(async () => { await client?.close(); client = null })

  it('answers an allowlisted server.session_list on the asking sidecar and refuses an unknown server.* method', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talaria-sidecar-server-'))
    const replies = join(dir, 'replies')
    // Handshakes, then asks the server twice and records every reply it reads on stdin.
    const script = `const fs=require('fs');const [fixture,params,replies]=process.argv.slice(1);require('readline').createInterface({input:process.stdin}).on('line',(line)=>{const msg=JSON.parse(line);if(msg.method==='runtime.handshake'){const result=JSON.parse(fs.readFileSync(fixture,'utf8'))['runtime.handshake'][0].result;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'s:1',method:'server.session_list',params:JSON.parse(params)})+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'s:2',method:'server.no_such_method',params:{}})+'\\n')}else if(typeof msg.id==='string'){fs.appendFileSync(replies,line+'\\n')}})`
    const seen: unknown[] = []
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, join(fixtures, 'runtime.json'), JSON.stringify(recorded.params), replies], agentDir: '', sidecarDir: dir, hermesHome: dir, log: () => undefined })
    client.serveSidecarRequests({ 'server.session_list': (params) => { seen.push(params); return Promise.resolve(recorded.result as never) } })
    await client.start()
    const deadline = Date.now() + 5000
    let lines: Record<string, unknown>[] = []
    while (lines.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      try { lines = readFileSync(replies, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) } catch { lines = [] }
    }
    const byId: Record<string, unknown> = Object.fromEntries(lines.map((line) => [String(line.id), line]))
    expect(seen).toEqual([SIDECAR_SERVER_METHODS['server.session_list'].params.parse(recorded.params)])
    expect(byId['s:1']).toEqual({ jsonrpc: '2.0', id: 's:1', result: recorded.result })
    expect(byId['s:2']).toMatchObject({ jsonrpc: '2.0', id: 's:2', error: { code: RPC_ERROR_CODES.methodNotFound, data: { condition: 'method_not_found' } } })
  })

  it('refuses invalid params, reports a handler refusal, and never dispatches a method without a handler', async () => {
    let calls = 0
    const handlers = { 'server.session_list': () => { calls += 1; return Promise.reject(new SidecarServerError('no Talaria session x', 'caller_unknown')) } }
    const ask = (method: string, params: Record<string, unknown>) => answerSidecarRequest(handlers, { jsonrpc: '2.0', id: 's:7', method, params })
    expect(await ask('server.session_list', { query: 'x' })).toMatchObject({ error: { code: RPC_ERROR_CODES.invalidParams } })
    expect(calls).toBe(0)
    expect(await ask('server.session_list', { caller_session_id: 'x' })).toMatchObject({ error: { code: RPC_ERROR_CODES.application, message: 'no Talaria session x', data: { condition: 'caller_unknown' } } })
    expect(await answerSidecarRequest({}, { jsonrpc: '2.0', id: 's:8', method: 'server.session_list', params: recorded.params })).toMatchObject({ error: { code: RPC_ERROR_CODES.methodNotFound } })
    expect(await ask('toString', {})).toMatchObject({ error: { code: RPC_ERROR_CODES.methodNotFound } })
    // Integer ids are the server's own requests' replies, never a sidecar request.
    expect(await answerSidecarRequest(handlers, { jsonrpc: '2.0', id: 3, method: 'server.session_list', params: {} })).toBeNull()
  })
})

describe('server.session_list (TAL-1164)', () => {
  it('lists only the calling session profile, newest first, with each row run state', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      mkdirSync(join(s.state, 'profiles', 'other'), { recursive: true })
      const save = async (session_id: string, profile: string, title: string, updated_at: number) => {
        await s.deps.sessionStore.save(new Session({ session_id, title, profile, updated_at, last_message_at: updated_at, messages: [{ role: 'user', content: title, timestamp: updated_at }] }, { workspace: s.state, model: null }), { touchUpdatedAt: false })
      }
      await save('agentcaller', 'default', 'Coordinate the release', 1_792_500_000)
      await save('agentpeer', 'default', 'Refactor the importer', 1_792_500_300)
      await save('agentforeign', 'other', 'Other profile work', 1_792_500_600)
      await save('agentforeigncaller', 'other', 'Other profile caller', 1_792_500_100)
      s.deps.pending.submitApproval('agentpeer', { command: 'rm -rf build', description: 'delete build output' })

      const reply = await sidecar.serverRequest('server.session_list', { caller_session_id: 'agentcaller' })
      expect('result' in reply).toBe(true)
      const result = SIDECAR_SERVER_METHODS['server.session_list'].result.parse((reply as { result: unknown }).result)
      expect(result.truncated).toBe(false)
      expect(result.sessions.map((row) => row.session_id)).toEqual(['agentpeer', 'agentcaller'])
      expect(result.sessions[0]).toEqual({ session_id: 'agentpeer', title: 'Refactor the importer', updated_at: 1_792_500_300, is_caller: false, is_streaming: false, pending_steer_count: 0, attention: { kind: 'approval', count: 1, severity: 'critical' } })
      expect(result.sessions[1]).toMatchObject({ session_id: 'agentcaller', is_caller: true, attention: null })

      const filtered = await sidecar.serverRequest('server.session_list', { caller_session_id: 'agentcaller', query: 'IMPORTER' })
      expect((filtered as { result: { sessions: { session_id: string }[] } }).result.sessions.map((row) => row.session_id)).toEqual(['agentpeer'])

      const other = await sidecar.serverRequest('server.session_list', { caller_session_id: 'agentforeigncaller' })
      expect((other as { result: { sessions: { session_id: string }[] } }).result.sessions.map((row) => row.session_id)).toEqual(['agentforeign', 'agentforeigncaller'])

      expect(await sidecar.serverRequest('server.session_list', { caller_session_id: 'nosuchsession' })).toMatchObject({ error: { data: { condition: 'caller_unknown' } } })
    } finally {
      await s.close()
    }
  })
})

describe('server.queue_list, server.queue_send_now, server.queue_withdraw (TAL-1167)', () => {
  it('lists, delivers and withdraws another session\'s pending steers, refusing self, cross-profile and read-only targets', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => (await (await s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })).json()) as Record<string, unknown>
      mkdirSync(join(s.state, 'profiles', 'other'), { recursive: true })
      const save = async (session_id: string, profile: string, extra: Record<string, unknown> = {}) => {
        await s.deps.sessionStore.save(new Session({ session_id, title: session_id, profile, updated_at: 1_792_500_000, messages: [{ role: 'user', content: session_id, timestamp: 1_792_500_000 }], ...extra }, { workspace: s.state, model: null }))
      }
      await save('agentcaller', 'default')
      await save('agentidle', 'default')
      await save('agentforeign', 'other')
      await save('agentimported', 'default', { read_only: true })
      await save('agentchild', 'default', { source_tag: 'subagent' })
      // A streaming target with two pending steers.
      const target = String(((await post('/api/session/new', {})).session as Record<string, unknown>).session_id)
      let finish: () => void = () => undefined
      sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null, can_redirect: true }))
      sidecar.respond('chat.start', (_params, emit) => new Promise((resolve) => {
        emit({ event: 'token', data: { text: 'working' } })
        finish = () => { resolve({ status: 'completed', messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'done' }], final_response: 'done', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] } as never) }
      }))
      const streamId = String((await post('/api/chat/start', { session_id: target, message: 'task' })).stream_id)
      await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
      await post('/api/chat/steer', { session_id: target, text: 'first', display_text: 'First', steer_id: 'steer-q1' })
      await post('/api/chat/steer', { session_id: target, text: 'second', display_text: 'Second', steer_id: 'steer-q2' })

      const ask = async (method: 'server.queue_list' | 'server.queue_send_now' | 'server.queue_withdraw', params: Record<string, unknown>) => {
        const reply = await sidecar.serverRequest(method, { caller_session_id: 'agentcaller', ...params })
        if ('error' in reply) return reply
        return { result: SIDECAR_SERVER_METHODS[method].result.parse(reply.result) }
      }
      const pending = (steer_id: string, text: string) => ({ steer_id, text, state: 'pending', actions: { edit: true, cancel: true, send_now: true } })
      expect(await ask('server.queue_list', { session_id: target })).toMatchObject({ result: { session_id: target, is_streaming: true, pending_steers: [pending('steer-q1', 'First'), pending('steer-q2', 'Second')] } })

      // send-now: each outcome the route answers.
      sidecar.respond('chat.steer_now', () => ({ redirected: true, withdrawn: true, delivery: 'steer' }))
      expect(await ask('server.queue_send_now', { session_id: target, steer_id: 'steer-q1' })).toEqual({ result: { redirected: true, outcome: 'delivered' } })
      expect(await ask('server.queue_send_now', { session_id: target, steer_id: 'steer-nope' })).toEqual({ result: { redirected: false, outcome: 'taken' } })
      sidecar.respond('chat.steer_now', () => ({ redirected: false, withdrawn: true, requeued: 'kept' }))
      expect(await ask('server.queue_send_now', { session_id: target, steer_id: 'steer-q2' })).toEqual({ result: { redirected: false, outcome: 'next_step' } })
      sidecar.respond('chat.steer_now', () => { throw new Error('synthetic redirect failure') })
      expect(await ask('server.queue_send_now', { session_id: target, steer_id: 'steer-q2' })).toEqual({ result: { redirected: false, outcome: 'failed' } })
      expect(await ask('server.queue_send_now', { session_id: 'agentidle', steer_id: 'steer-q2' })).toEqual({ result: { redirected: false, outcome: 'not_running' } })
      expect(await ask('server.queue_list', { session_id: target })).toMatchObject({ result: { pending_steers: [{ steer_id: 'steer-q2', state: 'pending' }, { steer_id: 'steer-q1', state: 'sending_now' }] } })

      // withdraw: taken back with its text, then gone.
      sidecar.respond('chat.steer_withdraw', () => ({ withdrawn: true }))
      expect(await ask('server.queue_withdraw', { session_id: target, steer_id: 'steer-q2' })).toEqual({ result: { withdrawn: true, text: 'Second' } })
      expect(await ask('server.queue_withdraw', { session_id: target, steer_id: 'steer-q2' })).toEqual({ result: { withdrawn: false } })
      expect(await ask('server.queue_list', { session_id: 'agentidle' })).toEqual({ result: { session_id: 'agentidle', is_streaming: false, pending_steers: [] } })

      // Refused targets, for every tool.
      for (const method of ['server.queue_list', 'server.queue_send_now', 'server.queue_withdraw'] as const) {
        const refused = (session_id: string) => ask(method, { session_id, steer_id: 'steer-q1' })
        expect(await refused('agentcaller')).toMatchObject({ error: { data: { condition: 'self_target' } } })
        expect(await refused('agentforeign')).toMatchObject({ error: { message: 'no Talaria session agentforeign in this profile', data: { condition: 'target_unknown' } } })
        expect(await refused('agentmissing')).toMatchObject({ error: { data: { condition: 'target_unknown' } } })
        expect(await refused('agentimported')).toMatchObject({ error: { message: 'Read-only imported sessions cannot be modified from WebUI', data: { condition: 'read_only' } } })
        expect(await refused('agentchild')).toMatchObject({ error: { message: 'Subagent sessions are view-only and cannot be written from WebUI', data: { condition: 'read_only' } } })
        expect(await sidecar.serverRequest(method, { caller_session_id: 'nosuchsession', session_id: target, steer_id: 'steer-q1' })).toMatchObject({ error: { data: { condition: 'caller_unknown' } } })
      }
      expect(await ask('server.queue_list', { session_id: target })).toMatchObject({ result: { pending_steers: [{ steer_id: 'steer-q1', state: 'sending_now' }] } })
      finish()
      await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
    } finally {
      await s.close()
    }
  })
})

describe('server.session_new, server.session_send, server.session_wait, server.session_interrupt (TAL-1165)', () => {
  it('starts, messages, waits on and stops another session, refusing self, cross-profile and read-only targets', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => (await (await s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })).json()) as Record<string, unknown>
      mkdirSync(join(s.state, 'profiles', 'other'), { recursive: true })
      const save = async (session_id: string, profile: string, extra: Record<string, unknown> = {}) => {
        await s.deps.sessionStore.save(new Session({ session_id, title: session_id, profile, updated_at: 1_792_500_000, messages: [{ role: 'user', content: session_id, timestamp: 1_792_500_000 }], ...extra }, { workspace: s.state, model: null }))
      }
      await save('agentforeign', 'other')
      await save('agentimported', 'default', { read_only: true })
      await save('agentchild', 'default', { source_tag: 'subagent' })
      // Every fake turn runs until the test finishes it with its reply.
      const finishers = new Map<string, (reply: string) => void>()
      const reply = (answer: string) => ({ status: 'completed', messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: answer }], final_response: answer, error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }) as never
      sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
        emit({ event: 'token', data: { text: 'working' } })
        finishers.set((params as { session_id: string }).session_id, (answer) => { resolve(reply(answer)) })
      }))
      sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null, can_redirect: true }))
      const finish = async (sid: string, answer: string) => {
        const streamId = s.deps.registry.activeRunStreamForSession(sid)!
        await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
        finishers.get(sid)!(answer)
        await s.deps.turns.finished(streamId)
      }
      const caller = String(((await post('/api/session/new', {})).session as Record<string, unknown>).session_id)
      // The caller's access: two toolsets and no YOLO. The profile default is `file` alone.
      const callerRow = await s.deps.sessionStore.get(caller)
      callerRow.enabled_toolsets = ['file', 'web']
      await s.deps.sessionStore.save(callerRow)
      sidecar.respond('toolsets.catalog', (params) => ({ toolsets: [], selected_toolsets: (params as { enabled_toolsets: string[] | null }).enabled_toolsets ?? ['file'], using_defaults: (params as { enabled_toolsets: string[] | null }).enabled_toolsets === null }))
      const ask = async (method: 'server.session_new' | 'server.session_send' | 'server.session_wait' | 'server.session_interrupt', params: Record<string, unknown>, callerId = caller) => {
        const answer = await sidecar.serverRequest(method, { caller_session_id: callerId, ...params })
        return 'error' in answer ? answer : { result: SIDECAR_SERVER_METHODS[method].result.parse(answer.result) }
      }

      // session_new: a chat in the caller's profile, titled, whose first turn is running.
      const created = await ask('server.session_new', { message: 'Fix the flaky test', title: 'Flaky test' })
      const target = (created as { result: { session_id: string } }).result.session_id
      expect(created).toEqual({ result: { session_id: target, title: 'Flaky test', stream_id: s.deps.registry.activeRunStreamForSession(target) } })
      expect(s.deps.registry.activeRunStreamForSession(target)).toMatch(/.+/)
      expect(await s.deps.sessionStore.get(target)).toMatchObject({ profile: 'default', pending_user_message: 'Fix the flaky test', enabled_toolsets: ['file', 'web'] })

      // session_send: a running target queues a pending steer; an idle one starts a turn.
      const queued = await ask('server.session_send', { session_id: target, message: 'Also update the changelog' })
      expect(queued).toMatchObject({ result: { outcome: 'queued', stream_id: s.deps.registry.activeRunStreamForSession(target) } })
      expect((queued as { result: { steer_id: string } }).result.steer_id).toMatch(/^steer-/)
      expect(s.deps.turns.pendingSteers(s.deps.registry.activeRunStreamForSession(target)!).map((steer) => steer.text)).toEqual(['Also update the changelog'])

      // session_wait: on timeout, then on the run's end with its reply.
      expect(await ask('server.session_wait', { session_id: target, timeout_s: 1 })).toMatchObject({ result: { session_id: target, outcome: 'timeout', is_streaming: true, run_state: 'running' } })
      const waiting = ask('server.session_wait', { session_id: target })
      await finish(target, 'All green')
      expect(await waiting).toEqual({ result: { session_id: target, outcome: 'ended', is_streaming: false, run_state: 'completed', last_assistant_message: 'All green', truncated: false } })
      expect(await ask('server.session_wait', { session_id: target })).toMatchObject({ result: { outcome: 'not_running', last_assistant_message: 'All green' } })

      const started = await ask('server.session_send', { session_id: target, message: 'Now the docs' })
      expect(started).toMatchObject({ result: { outcome: 'started', stream_id: s.deps.registry.activeRunStreamForSession(target), steer_id: null } })
      const long = 'x'.repeat(4500)
      const waitingLong = ask('server.session_wait', { session_id: target })
      await finish(target, long)
      expect(await waitingLong).toMatchObject({ result: { outcome: 'ended', last_assistant_message: 'x'.repeat(4000), truncated: true } })

      // A wait that lands while the target's turn is still being admitted waits for that turn, not for its absent worker.
      const store = s.deps.sessionStore
      const storeSave = store.save.bind(store)
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      store.save = async (...args: Parameters<typeof storeSave>) => { if (args[0].session_id === target && args[0].pending_user_message === 'Gated') await gate; return storeSave(...args) }
      const waitForRun = s.deps.turns.waitForRun.bind(s.deps.turns)
      let entered: () => void = () => undefined
      const waitEntered = new Promise<void>((resolve) => { entered = resolve })
      s.deps.turns.waitForRun = (...args: Parameters<typeof waitForRun>) => { entered(); return waitForRun(...args) }
      const gatedSend = ask('server.session_send', { session_id: target, message: 'Gated' })
      while (!s.deps.registry.activeRunStreamForSession(target)) await new Promise((resolve) => setTimeout(resolve, 5))
      const gatedWait = ask('server.session_wait', { session_id: target })
      await waitEntered
      release()
      store.save = storeSave
      s.deps.turns.waitForRun = waitForRun
      expect(await gatedSend).toMatchObject({ result: { outcome: 'started' } })
      await finish(target, 'Gated done')
      expect(await gatedWait).toMatchObject({ result: { outcome: 'ended', last_assistant_message: 'Gated done' } })

      // Stopping the caller's own turn ends its wait.
      const third = await ask('server.session_send', { session_id: target, message: 'One more thing' })
      await s.sse(`/api/chat/stream?stream_id=${(third as { result: { stream_id: string } }).result.stream_id}`, (f) => f.event === 'token')
      const callerStream = String((await post('/api/chat/start', { session_id: caller, message: 'orchestrate' })).stream_id)
      await s.sse(`/api/chat/stream?stream_id=${callerStream}`, (f) => f.event === 'token')
      const callerWait = ask('server.session_wait', { session_id: target })
      await s.get(`/api/chat/cancel?stream_id=${callerStream}`)
      expect(await callerWait).toMatchObject({ result: { outcome: 'cancelled', is_streaming: true } })

      // session_interrupt: stops the target's run, then finds nothing running.
      const running = s.deps.registry.activeRunStreamForSession(target)
      const interrupted = await ask('server.session_interrupt', { session_id: target })
      expect(interrupted).toMatchObject({ result: { ok: true, cancelled: true, stream_id: running } })
      // The fake Agent run returns once interrupted, as the real one unwinds.
      finishers.get(target)!('stopped')
      await s.deps.turns.finished((interrupted as { result: { stream_id: string } }).result.stream_id)
      expect(await ask('server.session_interrupt', { session_id: target })).toMatchObject({ result: { ok: true, cancelled: false } })

      // A session never hands work to one with more access than its own: YOLO, or a toolset the caller lacks.
      await save('agentyolo', 'default')
      await s.deps.sessions.setYolo('agentyolo', true)
      await save('agentwider', 'default', { enabled_toolsets: ['file', 'terminal'] })
      const routed = async (toolsets: string[] | null) => {
        const sid = String(((await post('/api/session/new', {})).session as Record<string, unknown>).session_id)
        const row = await s.deps.sessionStore.get(sid)
        row.enabled_toolsets = toolsets
        await s.deps.sessionStore.save(row)
        return sid
      }
      const narrow = await routed(['file'])
      const profileDefault = await routed(null)
      expect(await ask('server.session_send', { session_id: 'agentyolo', message: 'rm -rf' })).toMatchObject({ error: { message: 'session agentyolo has more access than this one (YOLO is on)', data: { condition: 'exceeds_caller' } } })
      expect(await ask('server.session_send', { session_id: 'agentwider', message: 'rm -rf' })).toMatchObject({ error: { message: 'session agentwider has more access than this one (toolsets: terminal)', data: { condition: 'exceeds_caller' } } })
      expect(await ask('server.session_send', { session_id: narrow, message: 'read the docs' })).toMatchObject({ result: { outcome: 'started' } })
      expect(await ask('server.session_send', { session_id: profileDefault, message: 'read the docs' })).toMatchObject({ result: { outcome: 'started' } })

      // Refused targets, for every tool that takes one.
      for (const method of ['server.session_send', 'server.session_wait', 'server.session_interrupt'] as const) {
        const refused = (session_id: string) => ask(method, { session_id, message: 'hi' })
        expect(await refused(caller)).toMatchObject({ error: { data: { condition: 'self_target' } } })
        expect(await refused('agentforeign')).toMatchObject({ error: { message: 'no Talaria session agentforeign in this profile', data: { condition: 'target_unknown' } } })
        expect(await refused('agentmissing')).toMatchObject({ error: { data: { condition: 'target_unknown' } } })
        expect(await refused('agentimported')).toMatchObject({ error: { message: 'Read-only imported sessions cannot be modified from WebUI', data: { condition: 'read_only' } } })
        expect(await refused('agentchild')).toMatchObject({ error: { message: 'Subagent sessions are view-only and cannot be written from WebUI', data: { condition: 'read_only' } } })
        expect(await ask(method, { session_id: target, message: 'hi' }, 'nosuchsession')).toMatchObject({ error: { data: { condition: 'caller_unknown' } } })
      }
      expect(await ask('server.session_new', { message: 'hi' }, 'nosuchsession')).toMatchObject({ error: { data: { condition: 'caller_unknown' } } })
      for (const finisher of finishers.values()) finisher('done')
    } finally {
      await s.close()
    }
  })
})
