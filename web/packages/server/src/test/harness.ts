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
import type { SidecarLike } from '../sidecar/client.js'

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
  deps?: (deps: AppDeps) => void
  sidecar?: SidecarLike | null
  gatewayPollMs?: number
  /** Install the SIGTERM/SIGINT/SIGHUP shutdown handlers (tests stub `process.exit` and remove them). */
  signals?: boolean
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
    // Never scan the real ~/.claude/projects (TAL-551).
    HERMES_WEBUI_CLAUDE_PROJECTS_DIR: join(state, 'claude-projects'),
    // Never read the real ~/.hermes/plugins dashboard plugins (TAL-267).
    HERMES_WEBUI_PLUGINS_DIR: join(state, 'plugins'),
    HERMES_WEBUI_HOST: '127.0.0.1',
    HERMES_WEBUI_PORT: '0',
    ...opts.env,
  }
  const deps = createDeps({ env, webRoot: WEB_ROOT, log: (line) => logs.push(line), version: 'web-v0.0.0-test', ...(opts.now ? { now: opts.now } : {}), ...(opts.sidecar !== undefined ? { sidecar: opts.sidecar } : {}), ...(opts.gatewayPollMs !== undefined ? { gatewayPollMs: opts.gatewayPollMs } : {}) })
  opts.deps?.(deps)
  const running = await startServer(createApp(deps), deps.config, { log: (line) => logs.push(line), signals: opts.signals ?? false })
  const base = `http://127.0.0.1:${running.port}`
  return {
    deps,
    running,
    base,
    state,
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
      rmSync(state, { recursive: true, force: true })
    },
  }
}

export function cookieHeader(setCookies: string[], name: string): string | undefined {
  return setCookies.map((c) => c.split(';')[0] ?? '').find((c) => c.startsWith(`${name}=`))
}
