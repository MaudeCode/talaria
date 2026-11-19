/** Boot one isolated server on an ephemeral port with a temp state directory. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, inject } from 'vitest'
import { createApp } from '../app.js'
import type { Env } from '../config.js'
import type { AppDeps } from '../http/context.js'
import { createDeps } from '../runtime.js'
import { startServer, type RunningServer } from '../server.js'
import type { SidecarLike } from '../sidecar/client.js'
import { RUN_SETTLE_MS } from '../cli/supervise.js'
import { dropTestSchema } from './postgres.js'

export const WEB_ROOT = resolve(import.meta.dirname, '../../../..')

/** A test's own handle on an Agent state.db. A booted server's state.db worker reads the same file, so writes wait out its lock instead of failing with "database is locked". */
export function openStateDb(path: string): DatabaseSync { return new DatabaseSync(path, { timeout: 5000 }) }

export interface TestServer {
  deps: AppDeps
  running: RunningServer
  base: string
  state: string
  workspace: string
  logs: string[]
  /** `fetch` that never follows redirects. */
  get: (path: string, init?: RequestInit) => Promise<Response>
  /** Raw HTTP/1.0 GET so the request target is sent verbatim (no WHATWG URL normalisation). */
  rawStatus: (target: string) => Promise<number>
  close: () => Promise<void>
  /** Open an SSE endpoint and collect frames until `until(event)` returns true, the stream closes, or the timeout elapses. */
  sse: (path: string, until: (event: SseFrame) => boolean, opts?: { headers?: Record<string, string>; timeoutMs?: number }) => Promise<SseFrame[]>
}

export interface SseFrame { event: string; data: unknown; id: string | null; raw: string }

export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = []
  let rest = buffer
  for (;;) {
    const idx = rest.indexOf('\n\n')
    if (idx < 0) break
    const block = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    if (!block.trim() || block.startsWith(':')) continue
    let event = 'message'
    let id: string | null = null
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('id:')) id = line.slice(3).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    const dataText = dataLines.join('\n')
    let data: unknown = dataText
    try { data = dataText ? JSON.parse(dataText) : {} } catch { data = dataText }
    frames.push({ event, data, id, raw: block })
  }
  return { frames, rest }
}

export interface BootOptions {
  env?: Env
  now?: () => number
  storage?: import('../runtime.js').CreateDepsOptions['storage']
  deps?: (deps: AppDeps) => void
  sidecar?: SidecarLike | null
  gatewayPollMs?: number
  /** Install the SIGTERM/SIGINT/SIGHUP shutdown handlers (tests stub `process.exit` and remove them). */
  signals?: boolean
  /** TAL-1628: the local-run drain budget `close` uses; a drain test passes its own. */
  drain?: import('../server.js').StartServerOptions['drain']
  /** Collects the server's log lines, so a test can read them when startup rejects. */
  logs?: string[]
}

/**
 * TAL-2185: a test server's close stops the runs its suite left going at once instead of waiting out the worker's
 * `RUN_DRAIN_MS` for them (a held fake turn never finishes on its own), so a suite's afterAll stays inside the hook timeout.
 */
const TEST_DRAIN = { waitMs: 0, settleMs: RUN_SETTLE_MS }

/**
 * A Postgres-backed server (TAL-1067) uses the run's embedded Postgres, in a schema named for its state directory, so a
 * restart on the same directory finds its data and every other server its own.
 */
function usePostgres(env: Env): string {
  const url = env.TALARIA_STORAGE_URL ?? inject('talariaPostgresUrl')
  if (!url) throw new Error('TALARIA_STORAGE=postgres tests need the embedded Postgres from vitest globalSetup')
  const schema = `t_${createHash('sha256').update(resolve(env.TALARIA_WEB_STATE_DIR ?? '')).digest('hex').slice(0, 24)}`
  Object.assign(env, { TALARIA_STORAGE_URL: url, TALARIA_STORAGE_SCHEMA: env.TALARIA_STORAGE_SCHEMA ?? schema, TALARIA_STORAGE_POOL_MAX: env.TALARIA_STORAGE_POOL_MAX ?? '4' })
  return env.TALARIA_STORAGE_SCHEMA ?? schema
}

export async function bootTestServer(opts: BootOptions = {}): Promise<TestServer> {
  const root = mkdtempSync(join(tmpdir(), 'talaria-server-test-'))
  const state = join(root, 'state')
  const workspace = join(root, 'workspace')
  const logs = opts.logs ?? []
  const env: Env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    HERMES_HOME: state,
    TALARIA_WEB_STATE_DIR: state,
    TALARIA_WEB_DEFAULT_WORKSPACE: workspace,
    // Never scan the real ~/.claude/projects (TAL-551).
    TALARIA_WEB_CLAUDE_PROJECTS_DIR: join(state, 'claude-projects'),
    TALARIA_WEB_HOST: '127.0.0.1',
    TALARIA_WEB_PORT: '0',
    // CI runs the suite once per backend (TAL-1066).
    ...(process.env.TALARIA_STORAGE ? { TALARIA_STORAGE: process.env.TALARIA_STORAGE } : {}),
    // A same-host auth proxy must be listed for trusted-header sign-in (TAL-2203); a test that omits it passes ''.
    ...(opts.env?.TALARIA_WEB_TRUSTED_AUTH_HEADER ? { TALARIA_WEB_TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128' } : {}),
    ...opts.env,
  }
  const postgresSchema = env.TALARIA_STORAGE === 'postgres' ? usePostgres(env) : null
  const deps = await createDeps({ ...(opts.storage ? { storage: opts.storage } : {}), env, webRoot: WEB_ROOT, log: (line) => logs.push(line), version: 'web-v0.0.0-test', ...(opts.now ? { now: opts.now } : {}), ...(opts.sidecar !== undefined ? { sidecar: opts.sidecar } : {}), ...(opts.gatewayPollMs !== undefined ? { gatewayPollMs: opts.gatewayPollMs } : {}) })
  opts.deps?.(deps)
  const running = await startServer(createApp(deps), deps.config, { log: (line) => logs.push(line), signals: opts.signals ?? false, drain: opts.drain ?? TEST_DRAIN })
  const base = `http://127.0.0.1:${running.port}`
  return {
    deps,
    running,
    base,
    state,
    workspace,
    logs,
    get: (path, init) => fetch(base + path, { redirect: 'manual', ...init }),
    sse: async (path, until, sseOpts = {}) => {
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, sseOpts.timeoutMs ?? 10_000)
      const frames: SseFrame[] = []
      try {
        const res = await fetch(base + path, { headers: sseOpts.headers ?? {}, signal: controller.signal })
        if (res.status !== 200 || !res.body) throw new Error(`SSE ${path} answered ${String(res.status)}: ${await res.text()}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value as Uint8Array, { stream: true })
          const parsed = parseSseChunk(buffer)
          buffer = parsed.rest
          let stop = false
          for (const frame of parsed.frames) {
            frames.push(frame)
            if (until(frame)) stop = true
          }
          if (stop) { controller.abort(); break }
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) throw error
      } finally {
        clearTimeout(timer)
      }
      return frames
    },
    rawStatus: (target) => new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: running.port }, () => { socket.write(`GET ${target} HTTP/1.0\r\nHost: localhost\r\n\r\n`) })
      let data = ''
      socket.on('data', (chunk: Buffer) => { data += chunk.toString('latin1') })
      socket.on('error', reject)
      socket.on('close', () => { resolve(Number(data.split(' ')[1])) })
    }),
    close: async () => {
      await running.close()
      // A test that names its own state directory may boot it again, like a SQLite database inside it.
      if (postgresSchema && env.TALARIA_WEB_STATE_DIR === state) await dropTestSchema(env.TALARIA_STORAGE_URL ?? '', postgresSchema)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function cookieHeader(setCookies: string[], name: string): string | undefined {
  return setCookies.map((c) => c.split(';')[0] ?? '').find((c) => c.startsWith(`${name}=`))
}

/**
 * For a suite sharing one server whose tests each set their own cron stores: a server clock (`bootTestServer({ now })`)
 * that each test moves past the store listing the last test left behind. `skip()` does the same mid-test. Only the
 * server's injected clock moves; real timers and `Date.now` stay real.
 */
export function freshCronListingsPerTest(): { now: () => number; skip: () => void } {
  let skew = 0
  beforeEach(() => { skew += 10 })
  return { now: () => Date.now() / 1000 + skew, skip: () => { skew += 10 } }
}
