import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { formatWakeupPrompt } from './completions.js'
import { nextSessionItem } from './streams.js'
import { HygieneTicker, rotateWebuiLog, webuiLogPaths } from '../tools/hygiene.js'
import { configFingerprint, McpHealthProber, probeServer } from '../tools/mcp-health.js'
import { agentHealth, remoteGatewayBaseUrl, runtimeStatusIsFresh } from '../tools/health.js'
import { RunJournal } from './journal.js'
import { str } from '../util.js'

type Json = Record<string, unknown>
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const completed = (text: string) => ({ status: 'completed' as const, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: text }], final_response: text, error: null, result_status: 'completed', tool_limit_reached: false, usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 1000 }, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] })

describe('background completion drain', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  it('formats completion and watch prompts like the Python drain', () => {
    expect(formatWakeupPrompt({ type: 'completion', session_id: 'proc_1', command: 'make', exit_code: 0, output: 'ok' })).toBe('[IMPORTANT: Background process proc_1 completed (exit_code=0).\nCommand: make\nOutput:\nok]')
    expect(formatWakeupPrompt({ type: 'watch_match', session_id: 'p', command: 'tail', pattern: 'ERR', output: 'boom', suppressed: 2 })).toContain('(2 earlier matches were suppressed by rate limit)')
    expect(formatWakeupPrompt({ type: 'watch_disabled', message: 'too many' })).toBe('[IMPORTANT: too many]')
    expect(formatWakeupPrompt({ type: 'completion' })).toBeNull()
    expect(formatWakeupPrompt({ type: 'other' })).toBeNull()
  })

  it('routes a completion to its session, emits bg_task_complete once, and starts a server-side wakeup turn', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const events = [{ process_id: 'proc_a', session_id: 'proc_a', type: 'completion', command: 'sleep 1', exit_code: 0, output: 'done', session_key: sid, origin_ui_session_id: sid, consumed: false }]
    let drains = 0
    sidecar.respond('process.drain', () => { drains += 1; return { events: drains === 1 ? events : [] } })
    const consumed: string[] = []
    sidecar.respond('process.mark_consumed', (params) => { consumed.push(params.process_id); return { ok: true } })
    const starts: string[] = []
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return completed('woke up') })
    const sub = s.deps.channels.subscribe(sid)
    expect(await s.deps.completions.drainOnce()).toBe(1)
    const item = await nextSessionItem(sub, 1000)
    expect(item?.[0]).toBe('bg_task_complete')
    expect(item?.[1]).toMatchObject({ session_id: sid, task_id: 'proc_a', summary: expect.stringContaining('Background process proc_a completed') as unknown })
    expect(String((item?.[1] as Json).event_id)).toHaveLength(32)
    expect((await nextSessionItem(sub, 200))?.[0]).toBe('process_complete')
    await new Promise((r) => setTimeout(r, 300))
    expect(starts).toHaveLength(1)
    expect(starts[0]).toContain('[IMPORTANT: Background process proc_a completed (exit_code=0).')
    expect(consumed).toEqual(['proc_a'])
    // A replayed event is deduped; an already-consumed one is skipped.
    expect(await s.deps.completions.processOne(events[0]!)).toBe(true)
    expect(await s.deps.completions.processOne({ ...events[0]!, process_id: 'proc_b', consumed: true })).toBe(true)
    expect(starts).toHaveLength(1)
    s.deps.channels.unsubscribe(sid, sub)
  })

  it('defers the wakeup while a turn is active and delivers it at teardown', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const starts: string[] = []
    let release: () => void = () => undefined
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return starts.length === 1 ? new Promise((resolve) => { release = () => { resolve(completed('first')) } }) : completed('second') })
    sidecar.respond('process.mark_consumed', () => ({ ok: true }))
    const started = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'hello' }))
    expect(started.stream_id).toBeTruthy()
    await new Promise((r) => setTimeout(r, 100))
    expect(await s.deps.completions.processOne({ process_id: 'proc_c', session_id: 'proc_c', type: 'completion', command: 'build', exit_code: 1, output: 'failed', origin_ui_session_id: sid, consumed: false })).toBe(true)
    expect(s.deps.completions.deferredCount(sid)).toBe(1)
    expect(starts).toHaveLength(1)
    release()
    for (let i = 0; i < 50 && starts.length < 2; i += 1) await new Promise((r) => setTimeout(r, 50))
    expect(starts).toHaveLength(2)
    expect(starts[1]).toContain('Background process proc_c completed (exit_code=1)')
    expect(s.deps.completions.deferredCount(sid)).toBe(0)
  })

  it('requeues async delegations it cannot route and drops orphan completions', async () => {
    const requeued: unknown[] = []
    sidecar.respond('process.drain', () => ({ events: [{ process_id: 'd1', type: 'async_delegation', session_key: 'nope', consumed: false }, { process_id: 'x', type: 'completion', session_key: 'nope', consumed: false }] }))
    sidecar.respond('process.requeue', (params) => { requeued.push(...params.events); return { requeued: params.events.length } })
    expect(await s.deps.completions.drainOnce()).toBe(0)
    expect(requeued).toHaveLength(1)
    expect((requeued[0] as Json).process_id).toBe('d1')
  })
})

describe('hygiene tick', () => {
  it('copy-truncates oversized logs into <log>.1 and honours the size cap', () => {
    const dir = join(process.env.TMPDIR ?? '/tmp', `talaria-hygiene-${String(process.pid)}-${String(Date.now())}`)
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'bootstrap-8787.log')
    writeFileSync(log, 'x'.repeat(2048))
    const lines: string[] = []
    expect(rotateWebuiLog([log], 4096, (l) => lines.push(l))).toBe(false)
    expect(rotateWebuiLog([log], 1024, (l) => lines.push(l))).toBe(true)
    expect(statSync(log).size).toBe(0)
    expect(readFileSync(`${log}.1`, 'utf8')).toHaveLength(2048)
    expect(lines[0]).toContain('Rotated the WebUI log')
    expect(rotateWebuiLog([log], 0, () => undefined)).toBe(false)
    expect(webuiLogPaths({ HERMES_WEBUI_LOG_FILE: '/var/log/talaria.log' }, dir, 1)).toEqual(['/var/log/talaria.log'])
    expect(webuiLogPaths({ HERMES_WEBUI_LOG_FILE: 'relative.log' }, dir, 8787)).toEqual([log])
  })

  it('prunes settled run journals past retention while keeping the newest three and live writers', async () => {
    const dir = join(process.env.TMPDIR ?? '/tmp', `talaria-journal-${String(process.pid)}-${String(Date.now())}`)
    const journal = new RunJournal(dir)
    const now = Date.now() / 1000
    for (let i = 0; i < 5; i += 1) {
      const w = journal.writer('sess1', `run${String(i)}`)
      w.appendSseEvent('token', { text: 'hi' })
      w.appendSseEvent('done', { session: {} })
      w.appendSseEvent('stream_end', {})
      w.close()
    }
    const live = journal.writer('sess1', 'live')
    live.appendSseEvent('done', { session: {} })
    live.appendSseEvent('stream_end', {})
    live.close()
    const dryRun = await journal.pruneSettled({ now: now + 30 * 86400, retentionSeconds: 14 * 86400, keepRecent: 3, dryRun: true })
    expect(dryRun).toMatchObject({ examined: 6, terminal: 6, pruned: 3 })
    // Files are brand new: nothing is older than the cutoff unless the clock says so.
    expect((await journal.pruneSettled({ now, retentionSeconds: 14 * 86400, keepRecent: 3 })).pruned).toBe(0)
    // The oldest run still has a live writer: retention must leave it alone; the two newest are kept.
    const activePath = journal.pathFor('sess1', 'run0')
    const result = await journal.pruneSettled({ now: now + 30 * 86400, retentionSeconds: 14 * 86400, keepRecent: 2, isActive: (p) => p === activePath })
    expect(result.pruned).toBe(3)
    expect(existsSync(activePath)).toBe(true)
    expect(existsSync(journal.pathFor('sess1', 'live'))).toBe(true)
    const summaries = ['run0', 'run1', 'run2', 'run3', 'run4', 'live'].filter((r) => existsSync(join(dir, '_run_journal', 'sess1', `${r}.summary.json`)))
    expect(summaries).toEqual(['run1', 'run2', 'run3'])
    const pruned = JSON.parse(readFileSync(join(dir, '_run_journal', 'sess1', `${summaries[0] ?? ''}.summary.json`), 'utf8')) as Json
    expect(pruned).toMatchObject({ journal_pruned: true, terminal: true, terminal_state: 'completed' })
    expect(journal.latestRunSummary('sess1', summaries[0] ?? '')).toMatchObject({ journal_pruned: true })
  })
})

describe('run-journal retention sweep', () => {
  const DAY = 86400
  const old = Date.now() / 1000 - 30 * DAY
  const writeRun = (journal: RunJournal, sid: string, runId: string, opts: { terminal?: boolean; bytes?: number; mtime?: number } = {}): string => {
    const w = journal.writer(sid, runId)
    w.appendSseEvent('token', { text: 'x'.repeat(opts.bytes ?? 2) })
    if (opts.terminal ?? true) { w.appendSseEvent('done', { session: {} }); w.appendSseEvent('stream_end', {}) }
    w.close()
    const path = journal.pathFor(sid, runId)
    utimesSync(path, opts.mtime ?? old, opts.mtime ?? old)
    return path
  }
  const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => { const p = join(d.parentPath, d.name); return `${p}:${String(statSync(p).size)}:${String(statSync(p).mtimeMs)}` }).sort()
  const ticker = (journal: RunJournal, clock: { now: number }, log: string[] = [], active = new Set<string>()) =>
    new HygieneTicker({ env: {}, stateDir: journal.sessionDir, port: () => 0, journal, activeJournalPaths: () => active, now: () => clock.now, log: (line) => log.push(line) })
  const dirs: string[] = []
  const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'talaria-retention-')); dirs.push(dir); return dir }
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })
  const gated = () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    return { gate, release }
  }

  it('answers HTTP while a retention sweep over a large backlog is still running', async () => {
    const s = await bootTestServer()
    // The sweep yields normally for its first units of work, then holds until HTTP has been answered.
    const { gate, release } = gated()
    try {
      const journal = s.deps.journal
      // Terminal and nonterminal journals, a few with tails past the 4 MiB read bound.
      for (let i = 0; i < 40; i += 1) {
        for (let r = 0; r < 5; r += 1) writeRun(journal, `sess${String(i)}`, `run${String(r)}`, { bytes: i < 2 ? 5 * 1024 * 1024 : 64 * 1024, mtime: old + r })
        writeRun(journal, `sess${String(i)}`, 'open', { terminal: false, mtime: old - 1 })
      }
      let reached!: () => void
      const midSweep = new Promise<void>((resolve) => { reached = resolve })
      let pauses = 0
      const prune = journal.pruneSettled.bind(journal)
      journal.pruneSettled = (opts) => prune({ ...opts, pause: () => { pauses += 1; if (pauses < 20) return new Promise((resolve) => setImmediate(resolve)); reached(); return gate } })
      let settled = false
      const sweep = Promise.resolve(s.deps.hygiene.tick()).then(() => { settled = true })
      await Promise.race([midSweep, sweep])
      const health = await s.get('/health')
      expect(health.status).toBe(200)
      expect(settled).toBe(false)
      release()
      await sweep
      for (const sid of ['sess0', 'sess39']) {
        expect(existsSync(journal.pathFor(sid, 'run0'))).toBe(false)
        expect(existsSync(journal.pathFor(sid, 'run2'))).toBe(true)
        expect(existsSync(journal.pathFor(sid, 'open'))).toBe(true)
      }
    } finally {
      // A failed assertion must not leave close() waiting on a held sweep.
      release()
      await s.close()
    }
  })

  it('waits for a running sweep on server close and stops it there', async () => {
    const s = await bootTestServer()
    const { gate, release } = gated()
    try {
      const journal = s.deps.journal
      for (let r = 0; r < 5; r += 1) writeRun(journal, 'sess', `run${String(r)}`, { mtime: old + r })
      const prune = journal.pruneSettled.bind(journal)
      journal.pruneSettled = (opts) => prune({ ...opts, pause: () => gate })
      void s.deps.hygiene.tick()
      const before = tree(s.state)
      // The server's own close (the harness close also deletes the state dir).
      let closed = false
      const closing = s.running.close().then(() => { closed = true })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(closed).toBe(false)
      release()
      await closing
      expect(tree(s.state)).toEqual(before)
    } finally {
      release()
      await s.close()
    }
  })

  it('runs one sweep at a time, recovers after a failure, and stops on shutdown', async () => {
    const journal = new RunJournal(tempDir())
    for (let r = 0; r < 5; r += 1) writeRun(journal, 'sess', `run${String(r)}`, { mtime: old + r })
    const clock = { now: Date.now() / 1000 }
    const log: string[] = []
    const t = ticker(journal, clock, log)
    const prune = journal.pruneSettled.bind(journal)
    let calls = 0
    journal.pruneSettled = () => { calls += 1; return Promise.reject(new Error('disk gone')) }
    await t.tick()
    expect(log.at(-1)).toBe('[webui] WARNING: run-journal retention failed: disk gone')
    // A failed sweep releases its slot: the next interval runs a real one.
    let { gate, release } = gated()
    journal.pruneSettled = (opts) => { calls += 1; return prune({ ...opts, pause: () => gate }) }
    clock.now += 6 * 3600
    const first = t.tick()
    expect(t.tick()).toBe(first)
    expect(calls).toBe(2)
    release()
    await first
    expect(log.at(-1)).toMatch(/^\[webui\] run-journal retention pruned 2 files/)
    // Stop aborts the in-flight sweep at its next yield and prevents later sweeps.
    for (let r = 5; r < 8; r += 1) writeRun(journal, 'sess', `run${String(r)}`, { mtime: old + r })
    ;({ gate, release } = gated())
    clock.now += 6 * 3600
    const stopped = t.tick()
    const before = tree(journal.sessionDir)
    // stop() hands back the in-flight sweep so shutdown can wait for it.
    const stopping = t.stop()
    expect(stopping).toBe(stopped)
    release()
    await stopping
    expect(tree(journal.sessionDir)).toEqual(before)
    clock.now += 6 * 3600
    await t.tick()
    expect(calls).toBe(3)
  })

  it('never compacts a journal that gains a writer or changes while the sweep yields', async () => {
    const journal = new RunJournal(tempDir())
    const paths = ['run0', 'run1', 'run2', 'run3', 'run4', 'run5'].map((r, i) => writeRun(journal, 'sess', r, { mtime: old + i }))
    const [activated, appended, replaced, racing, pruned] = paths as [string, string, string, string, string]
    const active = new Set<string>()
    // The racing journal already has a summary; rolling back restores it.
    writeFileSync(racing.replace(/\.jsonl$/, '.summary.json'), '{"prior":true}')
    let racingChecks = 0
    let pauses = 0
    const result = await journal.pruneSettled({
      now: Date.now() / 1000, retentionSeconds: 14 * DAY, keepRecent: 1,
      isActive: (p) => active.has(p) || (p === racing && (racingChecks += 1) > 1),
      // One pause opens the session and one follows each of its six parsed journals; the last precedes compaction.
      pause: async () => {
        pauses += 1
        if (pauses === 7) {
          active.add(activated)
          appendFileSync(appended, '\n')
          utimesSync(appended, old, old)
          // Rewritten in place with the same bytes and mtime: inode, size, and mtime all match, so only ctime tells it
          // apart. Wait past the filesystem's ctime granularity first.
          await new Promise((resolve) => setTimeout(resolve, 20))
          writeFileSync(replaced, readFileSync(replaced))
          utimesSync(replaced, old + 2, old + 2)
        }
      },
    })
    expect(result.pruned).toBe(1)
    for (const p of [activated, appended, replaced, racing]) {
      expect(existsSync(p)).toBe(true)
      expect(existsSync(p.replace(/\.jsonl$/, '.summary.json'))).toBe(p === racing)
    }
    expect(readFileSync(racing.replace(/\.jsonl$/, '.summary.json'), 'utf8')).toBe('{"prior":true}')
    expect(existsSync(pruned)).toBe(false)
    expect(existsSync(paths[5] ?? '')).toBe(true)
  })

  it('stops during the metadata pass before parsing any journal', async () => {
    const journal = new RunJournal(tempDir())
    for (let r = 0; r < 6; r += 1) writeRun(journal, 'sess', `run${String(r)}`, { mtime: old + r })
    const controller = new AbortController()
    // The abort lands on the next loop turn, while the sweep is listing and stat-ing the session's journals.
    const result = await journal.pruneSettled({ now: Date.now() / 1000, retentionSeconds: 14 * DAY, keepRecent: 1, signal: controller.signal, pause: () => { setImmediate(() => { controller.abort() }); return Promise.resolve() } })
    expect(result).toEqual({ examined: 6, terminal: 0, pruned: 0, bytes_reclaimed: 0 })
  })

  it('keeps nonterminal and recent journals, writes faithful summaries, and leaves dry runs and disabled retention untouched', async () => {
    const dir = tempDir()
    const journal = new RunJournal(dir)
    const now = Date.now() / 1000
    writeRun(journal, 'sess', 'a', { mtime: old })
    writeRun(journal, 'sess', 'b', { mtime: old })
    writeRun(journal, 'sess', 'c', { mtime: old })
    const live = writeRun(journal, 'sess', 'live', { terminal: false, mtime: old - DAY })
    appendFileSync(journal.pathFor('sess', 'a'), '{not json\n')
    utimesSync(journal.pathFor('sess', 'a'), old, old)
    writeRun(journal, 'small', 'only', { mtime: old })
    const before = tree(dir)
    expect(await new RunJournal(dir, { HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS: '0' }).pruneSettled({ now })).toEqual({ examined: 0, terminal: 0, pruned: 0, bytes_reclaimed: 0 })
    const dry = await journal.pruneSettled({ now, keepRecent: 1, dryRun: true })
    expect(dry).toMatchObject({ examined: 5, terminal: 3, pruned: 2 })
    expect(tree(dir)).toEqual(before)
    const expected = RunJournal.summaryFromEvents('sess', 'a', journal.readRunEvents('sess', 'a'))
    expect(await journal.pruneSettled({ now, keepRecent: 1 })).toMatchObject({ pruned: 2 })
    // Equal mtimes keep the path that sorts last; the nonterminal journal and a session under the keep count stay.
    expect(['a', 'b', 'c', 'live'].map((r) => existsSync(journal.pathFor('sess', r)))).toEqual([false, false, true, true])
    expect(existsSync(live)).toBe(true)
    expect(existsSync(journal.pathFor('small', 'only'))).toBe(true)
    const summary = JSON.parse(readFileSync(join(dir, '_run_journal', 'sess', 'a.summary.json'), 'utf8')) as Json
    expect(summary).toMatchObject({ ...expected, journal_pruned: true, journal_pruned_at: now })
    expect(summary.original_mtime).toBeCloseTo(old, 3)
    expect(journal.latestRunSummary('sess', 'a')).toMatchObject({ journal_pruned: true, terminal_state: 'completed' })
  })
})

describe('MCP health prober', () => {
  const fetchFor = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const calls: { method: string; headers: Record<string, string> }[] = []
    const f: typeof fetch = (input, init) => {
      calls.push({ method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) })
      if (typeof input !== 'string') throw new Error('string url expected')
      return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }))
    }
    return { f, calls }
  }

  it('classifies initialize replies, auth failures, protocol mismatches, and stdio commands', async () => {
    const ok = fetchFor(200, { jsonrpc: '2.0', id: 'hermes-webui-health', result: { protocolVersion: '2025-06-18', capabilities: {} } }, { 'Mcp-Session-Id': 'sess-1' })
    expect(await probeServer({ url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer t' } }, ok.f)).toEqual(['healthy', 'HTTP 200'])
    expect(ok.calls.map((c) => c.method)).toEqual(['POST', 'DELETE'])
    expect(ok.calls[1]?.headers).toMatchObject({ 'mcp-session-id': 'sess-1', 'mcp-protocol-version': '2025-06-18', authorization: 'Bearer t' })
    const sse = fetchFor(200, 'event: message\ndata: {"jsonrpc":"2.0","id":"hermes-webui-health","result":{"protocolVersion":"2025-03-26"}}\n\n')
    expect(await probeServer({ url: 'https://mcp.example/mcp' }, sse.f)).toEqual(['healthy', 'HTTP 200'])
    expect(await probeServer({ url: 'https://mcp.example/mcp' }, fetchFor(401, '').f)).toEqual(['needs_auth', 'HTTP 401'])
    expect(await probeServer({ url: 'https://mcp.example/mcp' }, fetchFor(404, '').f)).toEqual(['unknown', 'HTTP 404 (protocol mismatch)'])
    expect(await probeServer({ url: 'https://mcp.example/mcp' }, fetchFor(500, '').f)).toEqual(['unhealthy', 'HTTP 500'])
    expect(await probeServer({ url: 'https://mcp.example/mcp' }, fetchFor(200, { jsonrpc: '2.0', error: { message: 'nope' } }).f)).toEqual(['unhealthy', 'initialize rejected: nope'])
    expect(await probeServer({ url: 'ftp://mcp.example' }, ok.f)).toEqual(['unhealthy', 'unsupported url scheme'])
    expect(await probeServer({ command: 'sh' }, ok.f)).toEqual(['unknown', 'stdio server not probed'])
    expect(await probeServer({ command: 'definitely-missing-binary-xyz' }, ok.f)).toEqual(['unhealthy', 'command not found: definitely-missing-binary-xyz'])
    expect(await probeServer('nope', ok.f)).toEqual(['unhealthy', 'invalid config'])
    expect(configFingerprint({ b: 1, a: [2] })).toBe(configFingerprint({ a: [2], b: 1 }))
  })

  it('keys verdicts by config fingerprint and reports pending while a probe runs', async () => {
    let now = 1000
    const ok = fetchFor(200, { jsonrpc: '2.0', id: 'x', result: { protocolVersion: '2025-06-18' } })
    const prober = new McpHealthProber({ fetch: () => ok.f, now: () => now, log: () => undefined })
    const servers = { one: { url: 'https://one.example/mcp' } }
    expect(prober.refreshAndRead(servers).one).toEqual({ pending: true })
    await prober.settle()
    expect(prober.refreshAndRead(servers).one).toMatchObject({ health: 'healthy', detail: 'HTTP 200', checked_at: 1000, pending: false })
    expect(ok.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    // An edited config is a different identity and starts pending again; the old verdict never leaks.
    expect(prober.refreshAndRead({ one: { url: 'https://two.example/mcp' } }).one).toEqual({ pending: true })
    now += 200
    await prober.settle()
    expect(prober.refreshAndRead(servers).one).toMatchObject({ pending: true, health: 'healthy' })
  })
})

describe('agent health', () => {
  it('probes a remote gateway over HTTP with the api key on /health/detailed and caches for 5 s', async () => {
    const urls: string[] = []
    let now = 100
    const f: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      urls.push(url + ((init?.headers as Record<string, string> | undefined)?.Authorization ? ' [auth]' : ''))
      if (url.endsWith('/health/detailed')) return Promise.resolve(new Response('nope', { status: 404 }))
      return Promise.resolve(Response.json({ gateway_state: 'running' }))
    }
    const deps = { env: { HERMES_API_URL: 'http://gw:8642/health', HERMES_WEBUI_GATEWAY_API_KEY: 'k' }, hermesHome: '/nonexistent', profileHome: () => '/nonexistent', fetch: () => f, now: () => now }
    expect(remoteGatewayBaseUrl(deps.env)).toBe('http://gw:8642')
    const first = await agentHealth(deps)
    expect(first).toMatchObject({ alive: true, details: { state: 'alive', reason: 'remote_gateway', endpoint: 'http://gw:8642/health', status_code: 200, gateway_state: 'running' }, gateway_chat: { enabled: false, api_key_configured: true } })
    expect(urls).toEqual(['http://gw:8642/health/detailed [auth]', 'http://gw:8642/health'])
    await agentHealth(deps)
    expect(urls).toHaveLength(2)
    now += 10
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'))
    expect(await agentHealth({ ...deps, fetch: () => down })).toMatchObject({ alive: false, details: { state: 'down', reason: 'remote_gateway_unreachable', error: 'TypeError' } })
  })

  it('reads the local gateway pid and state file with the freshness rules', async () => {
    const dir = join(process.env.TMPDIR ?? '/tmp', `talaria-gw-${String(process.pid)}-${String(Date.now())}`)
    mkdirSync(dir, { recursive: true })
    const deps = { env: {}, hermesHome: dir, profileHome: () => dir, fetch: () => fetch, now: () => Date.now() / 1000 }
    expect(await agentHealth(deps)).toMatchObject({ alive: null, details: { state: 'unknown', reason: 'gateway_not_configured' } })
    writeFileSync(join(dir, 'gateway.pid'), String(process.pid))
    writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running', updated_at: new Date().toISOString(), active_agents: 2, platforms: { telegram: { state: 'connected' }, discord: { state: 'connected' } } }))
    expect(await agentHealth(deps)).toMatchObject({ alive: true, details: { state: 'alive', gateway_state: 'running', active_agents: 2, platform_count: 2, platform_states: { connected: 2 } } })
    writeFileSync(join(dir, 'gateway.pid'), '999999999')
    expect(await agentHealth(deps)).toMatchObject({ alive: true, details: { reason: 'cross_container_freshness' } })
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running', updated_at: old }))
    expect(await agentHealth(deps)).toMatchObject({ alive: null, details: { reason: 'gateway_stale_running_state' } })
    writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'stopped', updated_at: old }))
    expect(await agentHealth(deps)).toMatchObject({ alive: null, details: { reason: 'gateway_stale_stopped_state' } })
    writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'stopped', updated_at: new Date().toISOString() }))
    expect(await agentHealth(deps)).toMatchObject({ alive: false, details: { state: 'down', reason: 'gateway_not_running' } })
    expect(runtimeStatusIsFresh({ gateway_state: 'running', updated_at: '2026-01-01T00:00:00' }, Date.now() / 1000)).toBe(false)
  })
})
