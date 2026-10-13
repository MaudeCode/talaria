import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { CompletionDrain } from './completions.js'
import { BackgroundActivity, BackgroundTaskStore, taskView } from './background-tasks.js'
import { batchUpdate, eventUpdate, recordBackgroundUpdate } from './background-updates.js'
import { StreamRegistry, type SessionChannels } from './streams.js'

type Dict = Record<string, unknown>
const heartbeat = (sid: string, seq = 1): Dict => ({ type: 'heartbeat', process_id: 'proc_beat', session_id: 'proc_beat', command: 'npm test', seq, interval: 60, elapsed: seq * 61, started_at: 10, output: `test ${seq} passed`, origin_ui_session_id: sid, consumed: false })
const agentText = (evt: Dict): string => `[Background process proc_beat heartbeat #${String(evt.seq)}: ${String(evt.output)}]`

describe('process heartbeats (TAL-790)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => { sidecar = new FakeSidecar(); s = await bootTestServer({ sidecar }); s.deps.completions.stop() })
  afterAll(() => s.close())

  const setup = async () => {
    const response = await s.get('/api/session/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const sid = ((await response.json()) as { session: { session_id: string } }).session.session_id
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'run tests', _turn_id: 'user' }]
    s.deps.sessionStore.save(session)
    const registry = new StreamRegistry()
    const events: string[] = [], prompts: string[] = [], consumed: string[] = []
    const receipts = new BackgroundTaskStore(s.deps.sessionStore.sessionDir, () => 100)
    const activity = new BackgroundActivity({ store: receipts, sidecar: () => sidecar, profileHome: () => s.state, liveStream: () => false, now: () => 100, log: () => undefined })
    sidecar.respond('process.format_notification', ({ event }) => ({ text: agentText(event) }))
    sidecar.respond('process.mark_consumed', ({ process_id }) => { consumed.push(process_id); return { ok: true } })
    sidecar.respond('process.consumed', ({ process_ids }) => ({ consumed: process_ids }))
    const drain = new CompletionDrain({ sidecar: () => sidecar, baseHome: s.state, profileHome: () => s.state, activeProfile: () => 'default', store: s.deps.sessionStore,
      registry, channels: { emit: (_sid: string, name: string) => { events.push(name); return 1 } } as unknown as SessionChannels,
      background: activity, startTurn: (_session, prompt) => { prompts.push(prompt); return { stream_id: `wake-${prompts.length}` } }, now: () => 100, log: () => undefined })
    return { sid, session, registry, events, prompts, consumed, receipts, drain }
  }

  it('keeps each heartbeat running, wakes with Agent text, and only settles on exit', async () => {
    const { sid, events, prompts, consumed, receipts, drain } = await setup()
    try {
      for (const seq of [1, 2]) {
        const evt = heartbeat(sid, seq)
        expect(await drain.processOne(evt)).toBe(true)
        expect(taskView(receipts.get(sid, 'proc_beat')!)).toMatchObject({ status: 'running', completed_at: null, result_available: false })
        expect(receipts.get(sid, 'proc_beat')?.result).toContain(`test ${seq} passed`)
        expect(prompts).toHaveLength(seq)
        expect(prompts[seq - 1]).toBe(agentText(evt))
        expect(events).toEqual([])
        expect(consumed).toEqual([])
        expect(eventUpdate(evt)).toEqual({ kind: 'process', attention: false })
      }
      await drain.processOne({ ...heartbeat(sid), type: 'completion', exit_code: 0, output: 'all tests passed' })
      expect(taskView(receipts.get(sid, 'proc_beat')!)).toMatchObject({ status: 'completed', result_available: true, completed_at: 100 })
      expect(receipts.get(sid, 'proc_beat')?.result).toContain('all tests passed')
      expect(events).toEqual(['bg_task_complete', 'process_complete'])
      expect(consumed).toEqual(['proc_beat'])
      expect(prompts).toHaveLength(3)
    } finally { drain.stop() }
  })

  it('defers distinct heartbeats during a turn without consuming or deduplicating them as an exit', async () => {
    const { sid, registry, events, prompts, consumed, drain } = await setup()
    const channel = registry.create('busy', sid)
    const [subscriber] = channel.subscribeWithSnapshot()
    registry.registerActiveRun({ stream_id: 'busy', session_id: sid, started_at: 0, phase: 'running', workspace: '', model: null, provider: null, ephemeral: false })
    try {
      await drain.processOne(heartbeat(sid, 1))
      await drain.processOne(heartbeat(sid, 2))
      expect(drain.deferredCount(sid)).toBe(2)
      expect(prompts).toEqual([])
      expect(events).toEqual([])
      expect(subscriber.queue).toEqual([])
      registry.activeRuns.delete('busy')
      expect(await drain.drainDeferred(sid)).toBe(1)
      expect(prompts).toEqual([`${agentText(heartbeat(sid, 1))}\n\n${agentText(heartbeat(sid, 2))}`])
      expect(consumed).toEqual([])
      expect(await drain.drainDeferred(sid)).toBe(0)
    } finally { drain.stop() }
  })

  it('persists a hidden heartbeat prompt while its background reply remains visible, including after metadata pruning', async () => {
    const { sid, session, drain } = await setup()
    try {
      await drain.processOne(heartbeat(sid))
      session.messages.push({ role: 'user', content: agentText(heartbeat(sid)), _turn_id: 'wake-1', _source: 'process_wakeup' }, { role: 'assistant', content: 'Tests are progressing.', _turn_id: 'wake-1' })
      s.deps.sessionStore.save(session)
      const saved = JSON.parse(readFileSync(s.deps.sessionStore.pathFor(sid), 'utf8')) as { messages: Dict[] }
      expect(saved.messages.find((m) => m._source === 'process_wakeup')?.display_kind).toBe('hidden')
      // The turn metadata is bounded; old heartbeat prompts must not reappear when it is pruned.
      for (let i = 0; i < 201; i++) recordBackgroundUpdate(session, `later-${i}`, batchUpdate([{ event: { type: 'completion' }, prompt: 'done' }]))
      s.deps.sessionStore.save(session)
      const data = await (await s.get(`/api/session?session_id=${sid}&messages=1`)).json() as { session: { messages: Dict[] } }
      expect(data.session.messages.find((m) => m._source === 'process_wakeup')).toMatchObject({ _display: 'hidden' })
      expect(data.session.messages.find((m) => m.content === 'Tests are progressing.')).toMatchObject({ _display: 'row', _background_reply: true })
    } finally { drain.stop() }
  })

  it('keeps a mixed heartbeat and completion batch visible and a matched watch in attention', async () => {
    const { sid, receipts, drain } = await setup()
    try {
      const beat = heartbeat(sid)
      expect(batchUpdate([{ event: beat, prompt: agentText(beat) }])).toMatchObject({ display_kind: 'hidden', attention: false })
      expect(batchUpdate([{ event: beat, prompt: agentText(beat) }, { event: { type: 'completion', exit_code: 1 }, prompt: 'failed' }])).not.toHaveProperty('display_kind')
      await drain.processOne({ ...beat, type: 'watch_match', pattern: 'error', output: 'error found' })
      await drain.processOne(beat)
      expect(receipts.get(sid, 'proc_beat')?.status).toBe('attention')
    } finally { drain.stop() }
  })

  it('retains progress without emitting a completion when an older Agent cannot format a heartbeat', async () => {
    const { sid, receipts, drain, events, prompts } = await setup()
    sidecar.respond('process.format_notification', () => ({ text: '' }))
    try {
      await drain.processOne(heartbeat(sid))
      expect(receipts.get(sid, 'proc_beat')).toMatchObject({ status: 'running', result: 'test 1 passed' })
      expect(events).toEqual([])
      expect(prompts).toEqual([])
    } finally { drain.stop() }
  })
})
