import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { RuntimeDescribe } from '@maudecode/talaria-web-contracts'
import type { AppDeps } from '../http/context.js'
import type { RunningServer } from '../server.js'
import { FakeSidecar } from '../sidecar/fake.js'

const trial = vi.hoisted(() => ({
  state: '',
  sidecar: null as (FakeSidecar & { start: () => Promise<RuntimeDescribe> }) | null,
  deps: null as AppDeps | null,
  listening: vi.fn<(running: RunningServer) => void>(),
  resumed: false,
  mark: vi.fn<(stage: string) => void>(),
  attached: null as (() => Promise<void>) | null,
  unanswered: [] as string[],
}))

vi.mock('./dotenv.js', () => ({ loadStartupEnv: vi.fn(() => ({ hermesHome: trial.state })) }))
// Signals and IPC loss come from a private emitter: the test process's own channel and handlers stay untouched.
vi.mock('./supervise.js', async (original) => {
  const supervise = await original<typeof import('./supervise.js')>()
  const { EventEmitter } = await import('node:events')
  return { ...supervise, watchRetirement: (opts: import('./supervise.js').RetirementOptions) => {
    trial.mark('retirement registered')
    const retirement = supervise.watchRetirement({ ...opts, events: Object.assign(new EventEmitter(), { connected: true }), exit: () => undefined })
    const attach = retirement.attach
    retirement.attach = (close) => { trial.attached = close; attach(close) }
    return retirement
  } }
})
vi.mock('../sidecar/discover.js', () => ({ launchSidecar: () => trial.sidecar }))
// Version detection gets fixed git answers: the host checkout's index state is not this test's input.
vi.mock('node:child_process', async (original) => {
  const cp = await original<typeof import('node:child_process')>()
  const answers: Record<string, string> = { 'rev-parse': '', describe: 'web-v0.0.0-test', diff: '' }
  return { ...cp, execFileSync: (...args: Parameters<typeof cp.execFileSync>) => {
    const name = ['rev-parse', 'describe', 'diff-index', 'diff'].find((n) => args[1]?.includes(n)) ?? ''
    const command = `${args[0]} ${name}`
    trial.mark(`${command} started`)
    try {
      if (args[0] !== 'git') return cp.execFileSync(...args)
      if (name in answers && !args[1]?.includes('--binary')) return answers[name]!
      trial.unanswered.push(args[1]?.join(' ') ?? '')
      throw new Error(`unanswered git call: ${args[1]?.join(' ')}`)
    } finally { trial.mark(`${command} finished`) }
  } }
})
vi.mock('../config.js', async (original) => {
  const config = await original<typeof import('../config.js')>()
  return { ...config, loadConfig: (opts: Parameters<typeof config.loadConfig>[0]) => config.loadConfig({ ...opts, env: {
    HOME: trial.state, HERMES_HOME: trial.state, TALARIA_WEB_STATE_DIR: trial.state,
    TALARIA_WEB_DEFAULT_WORKSPACE: join(trial.state, 'workspace'),
    TALARIA_WEB_CLAUDE_PROJECTS_DIR: join(trial.state, 'claude-projects'),
    TALARIA_WEB_HOST: '127.0.0.1', TALARIA_WEB_PORT: '0',
  } }) }
})
vi.mock('../runtime.js', async (original) => {
  const runtime = await original<typeof import('../runtime.js')>()
  return { ...runtime, createDeps: async (opts: Parameters<typeof runtime.createDeps>[0]) => {
    trial.mark('dependency initialization started')
    const deps = await runtime.createDeps(opts)
    trial.mark('dependency initialization finished')
    // No supervisor, external connection, update, or background job belongs to this startup-order test.
    vi.spyOn(deps.relay, 'start').mockResolvedValue(false)
    vi.spyOn(deps.completions, 'start').mockImplementation(() => undefined)
    vi.spyOn(deps.hygiene, 'start').mockImplementation(() => undefined)
    vi.spyOn(deps.updates, 'startAutoApply').mockImplementation(() => undefined)
    vi.spyOn(deps.gatewayRestarts, 'resume').mockImplementation(() => { trial.resumed = true; return Promise.resolve() })
    trial.deps = deps
    return deps
  } }
})
vi.mock('../server.js', async (original) => {
  const server = await original<typeof import('../server.js')>()
  return { ...server, startServer: async (...args: Parameters<typeof server.startServer>) => {
    trial.mark('listener startup started')
    const running = await server.startServer(args[0], args[1], { signals: false })
    trial.mark('listener startup finished')
    trial.listening(running)
    return running
  } }
})

import { main } from './main.js'

it('serves auth and refuses chat while the sidecar handshake is pending', async () => {
  trial.state = mkdtempSync(join(tmpdir(), 'talaria-main-test-'))
  const fake = new FakeSidecar({ status: 'starting' })
  const describe = fake.describe!
  fake.describe = null
  let release!: () => void
  // Held until the test ends: listening and every request below happen while the handshake is pending.
  const handshake = new Promise<RuntimeDescribe>((resolve) => { release = () => { fake.describe = describe; fake.status = 'ready'; resolve(describe) } })
  fake.respond('runtime.ensure_current', async () => { await handshake; return { current: true, agent_revision: describe.agent_revision } })
  trial.sidecar = Object.assign(fake, { start: () => handshake })
  const listening = new Promise<RunningServer>((resolve) => { trial.listening.mockImplementation(resolve) })
  const events = ['exit', 'SIGINT', 'SIGTERM'] as const
  const emitter: import('node:events').EventEmitter = process
  const listeners = events.map((event) => new Set(emitter.listeners(event)))
  vi.stubEnv('TALARIA_WEB_WORKER', '1')
  vi.stubEnv('TALARIA_WEB_HOST', '127.0.0.1')
  vi.stubEnv('TALARIA_WEB_PORT', '8787')
  let failure: unknown
  const stages: string[] = []
  trial.mark.mockImplementation((stage) => { stages.push(stage) })
  const serving = main(['serve']).catch((error: unknown) => { failure = error })
  try {
    const base = `http://127.0.0.1:${(await listening).port}`
    const auth = await fetch(`${base}/api/auth/status`)
    expect(auth.status).toBe(200)
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const session = await (await post('/api/session/new', {})).json() as { session: { session_id: string } }
    const chat = await post('/api/chat/start', { session_id: session.session.session_id, message: 'hello' })
    expect(chat.status).toBe(503)
    expect(await chat.json()).toMatchObject({ condition: 'sidecar_unavailable' })
    expect((await trial.deps!.sessionStore.get(session.session.session_id)).pending_user_message).toBeNull()
    // Supervisor loss is watched before any startup work, and retires through the listener's own close.
    expect(stages[0]).toBe('retirement registered')
    expect(stages).toEqual(expect.arrayContaining(['git describe started', 'git diff started']))
    expect(trial.unanswered).toEqual([])
    expect(trial.attached).toBe((await listening).close)
    expect(process.env.TALARIA_WEB_WORKER).toBeUndefined()
  } finally {
    release()
    await vi.waitFor(() => { expect(trial.resumed).toBe(true) })
    const running = await listening
    await running.close()
    events.forEach((event, index) => {
      for (const listener of emitter.listeners(event)) if (!listeners[index]!.has(listener)) emitter.removeListener(event, listener as (...args: unknown[]) => void)
    })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(trial.state, { recursive: true, force: true })
  }
  expect(failure).toBeUndefined()
  void serving
})
