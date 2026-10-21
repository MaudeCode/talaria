import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SidecarClient } from '../sidecar/client.js'
import { expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { StartupTiming, timingKey, type StartupSpan } from '../startup-timing.js'
import { bootTestServer } from '../test/harness.js'

it('correlates admission, worker dispatch, first status and visible content without logging payloads', async () => {
  const sidecar = new FakeSidecar()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let reached!: () => void
  const dispatched = new Promise<void>((r) => { reached = r })
  let trace: unknown
  sidecar.respond('chat.start', async (_params, emit, opts) => {
    trace = (opts as unknown as { timing?: { traceId: string } }).timing?.traceId
    reached()
    await gate
    emit({ event: 'provider_phase', data: { phase: { phase: 'prompt_reading', progress_percent: null } } })
    for (let i = 0; i < 2000; i++) emit({ event: 'token', data: { text: 'PRIVATE_PROMPT_SECRET' } })
    throw new Error('PRIVATE_ERROR_SECRET /private/path https://provider.example/secret')
  })
  const server = await bootTestServer({ sidecar })
  try {
    const session = await server.deps.sessionStore.newSession()
    const warm = vi.spyOn(server.deps.sessions.deps, 'warmSessionModelRepair')
    const res = await server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: session.session_id, message: 'PRIVATE_PROMPT_SECRET' }) })
    expect(res.status).toBe(200)
    const body = await res.json() as { stream_id: string }
    await dispatched
    release()
    await server.deps.turns.finished(body.stream_id)
    const logs = server.logs.filter((l) => l.includes('"event":"chat_start_timing"')).map((l) => JSON.parse(l.slice(l.indexOf('{'))) as Record<string, unknown>)
    expect(logs.map((r) => r.stage)).toEqual(expect.arrayContaining(['acknowledgement', 'dispatch', 'first_visible', 'terminal']))
    expect(new Set(logs.map((r) => r.trace_id))).toEqual(new Set([trace]))
    expect(logs.length).toBeLessThanOrEqual(4)
    const terminal = logs.find((r) => r.stage === 'terminal')!
    expect(terminal.observations).toEqual(expect.objectContaining({ first_run_status: (expect.any(Number) as unknown), first_sidecar_output: (expect.any(Number) as unknown), first_visible_token: (expect.any(Number) as unknown) }))
    expect(warm).not.toHaveBeenCalled()
    expect(terminal.spans).toMatchObject({ catalog_wait: { outcome: 'noop' } })
    expect(terminal.provider_boundaries).toEqual({ first_call: 'unavailable', first_chunk: 'unavailable' })
    expect(JSON.stringify(logs)).not.toMatch(/PRIVATE_|\/private\/path|provider.example/)
  } finally { release(); vi.restoreAllMocks(); await server.close() }
})


it.each(['request_guards', 'owner_routing', 'runtime_barrier', 'session_load', 'ownership_checks', 'workspace_preparation', 'admission_checks', 'admission_persistence', 'workspace_persistence', 'worker_preparation'] as const)('keeps %s open across its held async boundary and closes it once', async (span) => {
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar })
  let release!: () => void
  const hold = new Promise<void>((r) => { release = r })
  let reached!: () => void
  const entered = new Promise<void>((r) => { reached = r })
  const timings: StartupTiming[] = []
  let now = 100
  try {
    const session = await server.deps.sessionStore.newSession()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with the captured receiver below
    const begin = StartupTiming.prototype.begin
    vi.spyOn(StartupTiming.prototype, 'begin').mockImplementation(function (this: StartupTiming, name: StartupSpan) {
      if (name === span) timings.push(this)
      return begin.call(this, name)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let held = false
    const pause = async () => { if (!timings.length || held) return; held = true; reached(); await hold }
    const service = server.deps.sessions
    const store = server.deps.sessionStore
    if (span === 'request_guards') { const f = service.sessionIdVisible.bind(service); vi.spyOn(service, 'sessionIdVisible').mockImplementation(async (...args) => { await pause(); return f(...args) }) }
    if (span === 'owner_routing') { const owner = service.owner!; const f = owner.isOwned.bind(owner); vi.spyOn(owner, 'isOwned').mockImplementation(async (...args) => { await pause(); return f(...args) }) }
    if (span === 'runtime_barrier') sidecar.respond('runtime.ensure_current', async () => { await pause(); return { current: true, agent_revision: null } })
    if (span === 'session_load') { const f = store.get.bind(store); vi.spyOn(store, 'get').mockImplementation(async (...args) => { await pause(); return f(...args) }) }
    if (span === 'ownership_checks') { const f = service.isReadOnly.bind(service); vi.spyOn(service, 'isReadOnly').mockImplementation(async (...args) => { await pause(); return f(...args) }) }
    if (span === 'workspace_preparation') { const f = service.turnWorkspace.bind(service); vi.spyOn(service, 'turnWorkspace').mockImplementation(async (...args) => { await pause(); return f(...args) }) }
    if (span === 'admission_checks') { const f = service.readOnlyReason.bind(service); vi.spyOn(service, 'readOnlyReason').mockImplementation(async (...args) => { await pause(); return f(...args) }) }
    if (span === 'admission_persistence') { const f = store.save.bind(store); vi.spyOn(store, 'save').mockImplementation(async (...args) => { await pause(); return f(...args) }) }
    if (span === 'workspace_persistence') { const f = server.deps.workspaces.setLastWorkspace.bind(server.deps.workspaces); vi.spyOn(server.deps.workspaces, 'setLastWorkspace').mockImplementation(async (...args) => { await pause(); return f(...args) }) }
    if (span === 'worker_preparation') { const f = server.deps.turns.deps.profileConfig!; vi.spyOn(server.deps.turns.deps, 'profileConfig').mockImplementation(async (...args) => { await pause(); return f(...args) }) }
    const response = server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: session.session_id, message: 'hello' }) })
    await entered
    expect(timings[0]!.snapshot().spans[span]).toMatchObject({ duration_ms: null, outcome: null })
    now += 75
    release()
    const body = await (await response).json() as { stream_id: string }
    await server.deps.turns.finished(body.stream_id)
    expect(timings[0]!.snapshot().spans[span]).toMatchObject({ duration_ms: 75, outcome: 'ok' })
    now += 500
    timings[0]!.end(span, 'error')
    expect(timings[0]!.snapshot().spans[span]).toMatchObject({ duration_ms: 75, outcome: 'ok' })
  } finally { release(); vi.restoreAllMocks(); await server.close() }
})

it('keeps interleaved workers correlated and records failed admission and no-op without dispatch', async () => {
  const sidecar = new FakeSidecar()
  const gates = new Map<string, () => void>()
  const traces = new Map<string, string>()
  sidecar.respond('chat.start', async (p, emit, opts) => {
    traces.set(p.session_id, opts.timing!.traceId)
    await new Promise<void>((r) => { gates.set(p.session_id, r) })
    emit({ event: 'token', data: { text: 'answer' } })
    throw new Error('PRIVATE_ERROR')
  })
  const server = await bootTestServer({ sidecar })
  const post = (id: string, message = 'hello') => server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: id, message }) })
  const logs = () => server.logs.filter((l) => l.includes('"event":"chat_start_timing"')).map((l) => JSON.parse(l.slice(l.indexOf('{'))) as unknown) as { stage: string; session_key: string; trace_id: string; outcome: string; spans: Record<string, unknown> }[]
  try {
    const first = await server.deps.sessionStore.newSession()
    const second = await server.deps.sessionStore.newSession()
    const [a, b] = await Promise.all([post(first.session_id).then((r) => r.json()), post(second.session_id).then((r) => r.json())]) as { stream_id: string }[]
    await vi.waitFor(() => { expect(gates.size).toBe(2) })
    gates.get(second.session_id)!()
    await server.deps.turns.finished(b!.stream_id)
    expect(logs().filter((r) => r.stage === 'terminal').map((r) => r.session_key)).toEqual([timingKey(second.session_id)])
    gates.get(first.session_id)!()
    await server.deps.turns.finished(a!.stream_id)
    for (const s of [first, second]) expect(new Set(logs().filter((r) => r.session_key === timingKey(s.session_id)).map((r) => r.trace_id))).toEqual(new Set([traces.get(s.session_id)]))
    vi.spyOn(server.deps.sessionStore, 'save').mockRejectedValueOnce(new Error('PRIVATE_ERROR /private/path'))
    expect((await post(first.session_id)).status).toBe(500)
    const failure = logs().filter((r) => r.stage === 'terminal').at(-1)!
    expect(failure.outcome).toBe('error')
    expect(failure.spans.admission_persistence).toMatchObject({ outcome: 'error' })
    expect((await post(second.session_id, '[SILENT]')).status).toBe(200)
    expect(logs().filter((r) => r.stage === 'terminal').at(-1)?.outcome).toBe('noop')
  } finally { for (const release of gates.values()) release(); vi.restoreAllMocks(); await server.close() }
})

it('records cancellation during worker preparation without sending chat.start', async () => {
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar })
  let release!: () => void
  const hold = new Promise<void>((r) => { release = r })
  let reached!: () => void
  const entered = new Promise<void>((r) => { reached = r })
  try {
    const session = await server.deps.sessionStore.newSession()
    const f = server.deps.turns.deps.profileConfig!
    vi.spyOn(server.deps.turns.deps, 'profileConfig').mockImplementation(async (...args) => { reached(); await hold; return f(...args) })
    const response = await server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: session.session_id, message: 'hello' }) })
    const body = await response.json() as { stream_id: string }
    await entered
    await server.deps.turns.cancel(body.stream_id)
    release()
    await server.deps.turns.finished(body.stream_id)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
    const log = server.logs.findLast((l) => l.includes('"event":"chat_start_timing"') && l.includes('"stage":"terminal"'))!
    expect(JSON.parse(log.slice(log.indexOf('{')))).toMatchObject({ outcome: 'cancelled', spans: { worker_preparation: { outcome: 'cancelled' } } })
  } finally { release(); vi.restoreAllMocks(); await server.close() }
})


it('carries one trace across an HTTP admission and real Python RPC stdio with separate process clocks', async () => {
  // This process proves the Node/Python envelope and logging boundary; Agent behavior remains fake.
  const state = mkdtempSync(join(tmpdir(), 'talaria-timing-transport-'))
  const logs: string[] = []
  let sidecarTerminal!: () => void
  const sidecarFinished = new Promise<void>((resolve) => { sidecarTerminal = resolve })
  const client = new SidecarClient({
    python: process.env.HERMES_WEBUI_TEST_PYTHON ?? 'python3',
    command: [process.env.HERMES_WEBUI_TEST_PYTHON ?? 'python3', resolve(import.meta.dirname, 'fixtures/startup-timing.py'), resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar')],
    agentDir: state, hermesHome: state, sidecarDir: resolve(import.meta.dirname, '../../../../sidecar'), log: (line) => {
      logs.push(line)
      if (line.includes('"event":"chat_start_timing"') && line.includes('"stage":"terminal"')) sidecarTerminal()
    },
  })
  let server: Awaited<ReturnType<typeof bootTestServer>> | undefined
  try {
    await client.start()
    server = await bootTestServer({ sidecar: client })
    const session = await server.deps.sessionStore.newSession()
    const response = await server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: session.session_id, message: 'synthetic prompt' }) })
    expect(response.status).toBe(200)
    const body = await response.json() as { stream_id: string }
    await server.deps.turns.finished(body.stream_id)
    // Python logs its terminal timing after the stdout RPC result, on a separate stderr pipe.
    await sidecarFinished
    const records = [...server.logs, ...logs].filter((line) => line.includes('"event":"chat_start_timing"')).map((line) => JSON.parse(line.slice(line.indexOf('{'))) as { process: string; trace_id: string; session_key: string; stream_key: string; stage: string })
    expect(new Set(records.map((r) => r.process))).toEqual(new Set(['server', 'sidecar']))
    expect(new Set(records.map((r) => r.trace_id)).size).toBe(1)
    expect(new Set(records.map((r) => r.session_key))).toEqual(new Set([timingKey(session.session_id)]))
    expect(records.filter((r) => r.stage === 'terminal').map((r) => r.stream_key)).toEqual([timingKey(body.stream_id), timingKey(body.stream_id)])
    expect(logs.join('\n')).not.toContain('synthetic prompt')
  } finally { await server?.close(); await client.close(); rmSync(state, { recursive: true, force: true }) }
})
