/** The fixture replay sidecar (`sidecar/scripts/replay_sidecar.py`) drives the real HTTP server without a Hermes Agent: the App contract runner's approval fixture. */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SidecarClient } from './client.js'
import { bootTestServer, type SseFrame, WEB_ROOT, type TestServer } from '../test/harness.js'

const python = ((): string | null => { try { return execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim() } catch { return null } })()
const replay = join(WEB_ROOT, 'sidecar', 'scripts', 'replay_sidecar.py')

describe.skipIf(!python)('replay sidecar', () => {
  let s: TestServer
  let sidecar: SidecarClient
  beforeAll(async () => {
    sidecar = new SidecarClient({ python: python!, command: [python!, replay], agentDir: '', sidecarDir: join(WEB_ROOT, 'sidecar'), hermesHome: '', log: () => undefined })
    s = await bootTestServer({ sidecar })
    ;(sidecar as unknown as { opts: { hermesHome: string } }).opts.hermesHome = s.state
    const describe = await sidecar.start()
    expect(describe.compatible).toBe(true)
  })
  afterAll(async () => { await sidecar.close(); await s.close() })

  it('serves recorded fixtures and stages the contract approval on chat start', async () => {
    const profiles = await (await s.get('/api/profiles')).json() as { profiles: { name: string }[]; active: string }
    expect(profiles.profiles.map((p) => p.name)).toContain('default')
    const created = await (await fetch(`${s.base}/api/session/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: join(s.state, 'workspace') }) })).json() as { session: { session_id: string } }
    const sid = created.session.session_id
    // The staged approval may already be pending when the stream attaches, in which case it rides in the `initial` snapshot.
    const staged = (frame: SseFrame): boolean => (frame.event === 'approval' || frame.event === 'initial') && Boolean((frame.data as { pending: unknown }).pending)
    const approval = s.sse(`/api/approval/stream?session_id=${sid}`, staged)
    const start = await (await fetch(`${s.base}/api/chat/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid, message: 'contract fixture' }) })).json() as { stream_id?: string; error?: string }
    expect(start.stream_id).toBeTruthy()
    const frames = await approval
    expect(frames[0]?.event).toBe('initial')
    const event = frames.find(staged)
    expect((event!.data as { pending: { pattern_key: string } }).pending.pattern_key).toBe('talaria_contract_fixture')
    const answered = await fetch(`${s.base}/api/approval/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid, choice: 'once', approval_id: 'talaria-contract-approval' }) })
    expect(answered.status).toBe(200)
    // The replay sidecar's `chat.start` result passes the same contract as the real one, so the turn settles as `done`.
    const turn = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'stream_end' || f.event === 'apperror')
    expect(turn.map((f) => f.event)).toContain('done')
    expect(turn.find((f) => f.event === 'apperror')?.data).toBeUndefined()
  })
})
