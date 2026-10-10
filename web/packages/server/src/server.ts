/**
 * Listener lifecycle (Python `server.py` main): port exclusivity probe, HTTP or
 * TLS 1.2+ server with an HTTP fallback, keep-alive tuning, and orderly
 * SIGTERM/SIGINT/SIGHUP shutdown.
 */
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import type { App } from './app.js'
import type { ServerConfig } from './config.js'
import { fixCredentialPermissions, warnUnauthenticatedBind } from './startup.js'

export async function isAlreadyServing(host: string, port: number): Promise<boolean> {
  const probeHost = ['0.0.0.0', '', '::'].includes(host) ? '127.0.0.1' : host
  return new Promise((resolve) => {
    const socket = connect({ host: probeHost, port })
    let done = false
    const finish = (value: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(2000, () => { finish(false) })
    socket.on('error', () => { finish(false) })
    socket.on('connect', () => { socket.write('GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n') })
    socket.on('data', (data: Buffer) => { finish(data.length > 0) })
    socket.on('close', () => { finish(false) })
  })
}

export const REQUEST_TIMEOUT_MS = 120_000
const CONNECTIONS_CHECKING_INTERVAL_MS = 5_000

export interface RunningServer {
  server: Server
  scheme: 'http' | 'https'
  port: number
  close: () => Promise<void>
}

export async function startServer(app: App, config: ServerConfig, opts: { log?: (line: string) => void; signals?: boolean } = {}): Promise<RunningServer> {
  const log = opts.log ?? ((line) => { console.log(line) })
  if (await isAlreadyServing(config.host, config.port)) {
    throw new Error(`Another server is already responding on ${config.host}:${config.port}. Stop the existing instance first.`)
  }
  fixCredentialPermissions(config, log)
  let scheme: 'http' | 'https' = 'http'
  let server: Server
  const listener = (req: Parameters<App['handler']>[0], res: Parameters<App['handler']>[1]) => { void app.handler(req, res) }
  if (config.tlsCert && config.tlsKey) {
    try {
      server = createHttpsServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey), minVersion: 'TLSv1.2', connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS }, listener)
      scheme = 'https'
      log(`  TLS enabled: cert=${config.tlsCert}, key=${config.tlsKey}`)
    } catch (error) {
      log(`[!!] WARNING: TLS setup failed (${String(error)}), falling back to HTTP`)
      server = createHttpServer({ connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS }, listener)
    }
  } else {
    server = createHttpServer({ connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS }, listener)
  }
  server.keepAliveTimeout = 30_000
  server.headersTimeout = 35_000
  // Bounds receiving the request (headers and body) only; a streamed response outlives it. A client that drips or
  // stalls an in-limit body therefore holds a socket for at most this long (Python's handler timeout was 30 s).
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.on('connection', (socket) => {
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 10_000)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  log(`  Talaria Web listening on ${scheme}://${config.host}:${port}`)
  await warnUnauthenticatedBind(config.host, app.deps.auth, log)
  const close = async () => {
    const hygiene = app.deps.hygiene.stop()
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    })
    // A retention sweep finishes its current file step before the process exits.
    await hygiene
    // Auth state is persisted write-behind: land pending session and login-attempt writes before the process exits.
    await app.deps.auth.flushPersistence()
  }
  if (opts.signals ?? true) {
    let requested = false
    const onSignal = (signal: NodeJS.Signals) => {
      if (requested) return
      requested = true
      log(`[webui] ${signal} received; shutting down`)
      void close().then(() => { process.exit(0) })
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
    // The `serve` supervisor forwards SIGHUP too; its default action would exit before auth writes land.
    process.once('SIGHUP', onSignal)
  }
  return { server, scheme, port, close }
}
