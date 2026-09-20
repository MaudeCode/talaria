/** Boot one isolated server on an ephemeral port with a temp state directory. */
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../app.js'
import type { Env } from '../config.js'
import type { AppDeps } from '../http/context.js'
import { createDeps } from '../runtime.js'
import { startServer, type RunningServer } from '../server.js'

export const WEB_ROOT = resolve(import.meta.dirname, '../../../..')

export interface TestServer {
  deps: AppDeps
  running: RunningServer
  base: string
  state: string
  logs: string[]
  /** `fetch` that never follows redirects. */
  get: (path: string, init?: RequestInit) => Promise<Response>
  /** Raw HTTP/1.0 GET so the request target is sent verbatim (no WHATWG URL normalisation). */
  rawStatus: (target: string) => Promise<number>
  close: () => Promise<void>
}

export interface BootOptions {
  env?: Env
  now?: () => number
  deps?: (deps: AppDeps) => void
}

export async function bootTestServer(opts: BootOptions = {}): Promise<TestServer> {
  const state = mkdtempSync(join(tmpdir(), 'talaria-server-test-'))
  const logs: string[] = []
  const env: Env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    HERMES_HOME: state,
    HERMES_WEBUI_STATE_DIR: state,
    HERMES_WEBUI_DEFAULT_WORKSPACE: join(state, 'workspace'),
    HERMES_WEBUI_HOST: '127.0.0.1',
    HERMES_WEBUI_PORT: '0',
    ...opts.env,
  }
  const deps = createDeps({ env, webRoot: WEB_ROOT, log: (line) => logs.push(line), version: 'web-v0.0.0-test', ...(opts.now ? { now: opts.now } : {}) })
  opts.deps?.(deps)
  const running = await startServer(createApp(deps), deps.config, { log: (line) => logs.push(line), signals: false })
  const base = `http://127.0.0.1:${running.port}`
  return {
    deps,
    running,
    base,
    state,
    logs,
    get: (path, init) => fetch(base + path, { redirect: 'manual', ...init }),
    rawStatus: (target) => new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: running.port }, () => { socket.write(`GET ${target} HTTP/1.0\r\nHost: localhost\r\n\r\n`) })
      let data = ''
      socket.on('data', (chunk: Buffer) => { data += chunk.toString('latin1') })
      socket.on('error', reject)
      socket.on('close', () => { resolve(Number(data.split(' ')[1])) })
    }),
    close: async () => {
      await running.close()
      rmSync(state, { recursive: true, force: true })
    },
  }
}

export function cookieHeader(setCookies: string[], name: string): string | undefined {
  return setCookies.map((c) => c.split(';')[0] ?? '').find((c) => c.startsWith(`${name}=`))
}
