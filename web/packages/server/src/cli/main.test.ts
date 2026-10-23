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
}))

vi.mock('./dotenv.js', () => ({ loadStartupEnv: vi.fn() }))
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
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, fsyncSync: (fd: number) => {
    trial.mark('filesystem flush started')
    try { fs.fsyncSync(fd) } finally { trial.mark('filesystem flush finished') }
  } }
})
vi.mock('node:child_process', async (original) => {
  const cp = await original<typeof import('node:child_process')>()
  return { ...cp, execFileSync: (...args: Parameters<typeof cp.execFileSync>) => {
    const command = `${args[0]} ${['rev-parse', 'describe', 'diff-index', 'diff'].find((name) => args[1]?.includes(name)) ?? ''}`
    trial.mark(`${command} started`)
    try { return cp.execFileSync(...args) } finally { trial.mark(`${command} finished`) }
  } }
})
vi.mock('../config.js', async (original) => {
  const config = await original<typeof import('../config.js')>()
  return { ...config, loadConfig: (opts: Parameters<typeof config.loadConfig>[0]) => config.loadConfig({ ...opts, env: {
    HOME: trial.state, HERMES_HOME: trial.state, HERMES_WEBUI_STATE_DIR: trial.state,
    HERMES_WEBUI_DEFAULT_WORKSPACE: join(trial.state, 'workspace'),
    HERMES_WEBUI_CLAUDE_PROJECTS_DIR: join(trial.state, 'claude-projects'),
    HERMES_WEBUI_HOST: '127.0.0.1', HERMES_WEBUI_PORT: '0',
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
    running.server.on('request', (req, res) => {
      if (req.url !== '/api/auth/status') return
      trial.mark('auth request accepted')
      res.once('finish', () => { trial.mark('auth response finished') })
    })
    trial.listening(running)
    return running
  } }
})

import { main } from './main.js'

it('serves auth within 500 ms and refuses chat while a five-second handshake is pending', async () => {
  trial.state = mkdtempSync(join(tmpdir(), 'talaria-main-test-'))
  const fake = new FakeSidecar({ status: 'starting' })
  const describe = fake.describe!
  fake.describe = null
  let release!: () => void
  const handshake = new Promise<RuntimeDescribe>((resolve) => { release = () => { fake.describe = describe; fake.status = 'ready'; resolve(describe) } })
  const timer = setTimeout(() => { release() }, 5000)
  fake.respond('runtime.ensure_current', async () => { await handshake; return { current: true, agent_revision: describe.agent_revision } })
  trial.sidecar = Object.assign(fake, { start: () => handshake })
  const listening = new Promise<RunningServer>((resolve) => { trial.listening.mockImplementation(resolve) })
  const events = ['exit', 'SIGINT', 'SIGTERM'] as const
  const emitter: import('node:events').EventEmitter = process
  const listeners = events.map((event) => new Set(emitter.listeners(event)))
  vi.stubEnv('TALARIA_WEB_WORKER', '1')
  vi.stubEnv('HERMES_WEBUI_HOST', '127.0.0.1')
  vi.stubEnv('HERMES_WEBUI_PORT', '8787')
  let deadline: ReturnType<typeof setTimeout> | undefined
  let failure: unknown
  const started = performance.now()
  const stages: { stage: string; ms: number }[] = []
  trial.mark.mockImplementation((stage) => { stages.push({ stage, ms: performance.now() - started }) })
  const serving = main(['serve']).catch((error: unknown) => { failure = error })
  try {
    const reachable = listening.then(async (running) => {
      const base = `http://127.0.0.1:${running.port}`
      const auth = await fetch(`${base}/api/auth/status`)
      trial.mark('auth response headers received')
      expect(auth.status).toBe(200)
      return base
    })
    const base = await Promise.race([reachable, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        trial.mark('deadline fired')
        reject(new Error(`HTTP auth listener was not reachable within 500 ms; stages: ${JSON.stringify(stages)}`))
      }, 500)
    })])
    expect(performance.now() - started).toBeLessThan(500)
    expect(fake.status).toBe('starting')
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(500) })
    const session = await (await post('/api/session/new', {})).json() as { session: { session_id: string } }
    const chat = await post('/api/chat/start', { session_id: session.session.session_id, message: 'hello' })
    expect(chat.status).toBe(503)
    expect(await chat.json()).toMatchObject({ condition: 'sidecar_unavailable' })
    expect(fake.status).toBe('starting')
    expect((await trial.deps!.sessionStore.get(session.session.session_id)).pending_user_message).toBeNull()
    // Supervisor loss is watched before any startup work, and retires through the listener's own close.
    expect(stages[0]?.stage).toBe('retirement registered')
    expect(trial.attached).toBe((await listening).close)
    expect(process.env.TALARIA_WEB_WORKER).toBeUndefined()
  } finally {
    clearTimeout(timer)
    clearTimeout(deadline)
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
