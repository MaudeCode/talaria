/**
 * The `talaria-web` commands (Python `start.sh` + `bootstrap.py` + `ctl.sh`), loaded by `bin/talaria-web.ts`:
 *   talaria-web [port] [--host H] [--no-browser] [--foreground] [--skip-agent-install]   launch (detached unless supervised)
 *   talaria-web serve [launcher args]                                                     run the server (supervised worker; self-update restarts it)
 *   talaria-web ctl <start|stop|restart|status|logs> [...]                                daemon control
 *   talaria-web storage copy --from <json|sqlite|postgres> --to <json|sqlite|postgres>    move sessions, documents and journals (server stopped)
 *   talaria-web storage copy-blobs --from <local|s3> --to <local|s3>                       copy chat attachments (server stopped)
 */
import { createApp } from '../app.js'
import { loadConfig, migrateLegacyWebEnv } from '../config.js'
import { createDeps } from '../runtime.js'
import { loadReleaseInfo } from '../release.js'
import { startServer } from '../server.js'
import { launchSidecar } from '../sidecar/discover.js'
import { loadStartupEnv } from './dotenv.js'
import { parseBootstrapArgs, runBootstrap } from './launcher.js'
import { runCtl } from './ctl.js'
import { runStorage } from './storage.js'
import { resolveWebRoot } from './web-root.js'
import { supervise, watchRetirement, WORKER_ENV } from './supervise.js'

const log = (line: string): void => { console.log(line) }
const warn = (line: string): void => { console.error(line) }
const bin = process.argv[1] ?? ''
const serveCommand = [process.execPath, bin, 'serve']

function applyServeArgs(argv: string[]): void {
  const args = parseBootstrapArgs(argv, process.env)
  process.env.TALARIA_WEB_HOST = args.host
  process.env.TALARIA_WEB_PORT = String(args.port)
}

/** The long-lived server: `.env` precedence, Agent sidecar, workers. A supervisor parent respawns the worker after a self-update. */
async function serve(args: string[], webRoot: string): Promise<number> {
  applyServeArgs(args)
  const config = loadConfig({ webRoot })
  if (process.env[WORKER_ENV] !== '1') return supervise({ command: [...serveCommand, ...args], env: process.env, log, packageRoot: webRoot, stateDir: config.stateDir })
  // Consumed here: the worker's own children (terminals, sidecar) are not supervised workers.
  Reflect.deleteProperty(process.env, WORKER_ENV)
  // Before any startup work: a worker whose supervisor is gone must not keep, or go on to take, the port. A channel
  // that existed is `null` once its supervisor died; a worker run directly (contract probe) never had one.
  const retirement = watchRetirement({ log, supervised: process.channel !== undefined })
  const sidecar = launchSidecar({ env: config.env, hermesHome: config.hermesHome, webRoot, home: config.homeDir, log })
  // Handle rejection immediately: dependency initialization and listening must not wait for Agent imports.
  const starting = sidecar?.start().then(
    (describe) => {
      log(`[sidecar] ready: agent ${describe.agent_version ?? describe.agent_revision ?? 'unknown'} (${describe.compatible ? 'compatible' : 'incompatible'})`)
    },
    (error: unknown) => {
      log(`[sidecar] failed to start: ${(error as Error).message}; chat is unavailable until it recovers`)
    },
  )
  const deps = await createDeps({ webRoot, sidecar })
  // Every exit path (SIGINT/SIGTERM shutdown, `/api/shutdown`, self-update restart) reaps embedded terminals first.
  process.on('exit', () => { deps.updates.stopAutoApply(); deps.terminals.closeAll({ immediate: true }) })
  // Renamed root profiles and the active profile's config must be known before the first request (Python read both
  // synchronously at startup); until then local-I/O gates fail closed.
  await deps.profiles.warmRootAliases()
  await Promise.resolve().then(() => deps.agentConfig.read(deps.profileHome(deps.activeProfile()))).catch(() => undefined)
  const app = createApp(deps)
  // A worker that cannot listen (a refused configuration, a taken port) must exit with its code: the running sidecar
  // child would otherwise keep it alive, unlistening, and its supervisor would never see the exit (TAL-2197).
  const running = await startServer(app, deps.config, { signals: false }).catch(async (error: unknown) => {
    await sidecar?.close()
    throw error
  })
  retirement.attach(running.close, running.escalate)
  if (process.connected) process.send?.('ready')
  await starting
  await deps.notifications.start()
  // A shutdown already stopped the background work; never restart it behind the close.
  if (!retirement.retiring) {
    deps.completions.start()
    deps.hygiene.start()
    deps.updates.startAutoApply()
    // TAL-1990: the chats an Update anyway interrupted continue on the restarted server.
    void deps.updates.resumeContinuations()
    await deps.gatewayRestarts.resume()
    log(`  Then open:     ${running.scheme}://localhost:${running.port}`)
  }
  await new Promise<void>(() => undefined)
  return 0
}

export async function main(argv: string[]): Promise<number> {
  let webRoot = ''
  let hermesHome = ''
  const home = process.env.HOME ?? ''
  migrateLegacyWebEnv(process.env, warn, (normalizeEnv) => {
    webRoot = process.env.TALARIA_WEB_ROOT ?? resolveWebRoot(import.meta.dirname)
    hermesHome = loadStartupEnv({ env: process.env, webRoot, home, log: warn, normalizeEnv }).hermesHome
  })
  const [first, ...rest] = argv
  if (first === 'ctl') return runCtl({ env: process.env, webRoot, home: process.env.HOME ?? '', serveCommand, log, warn }, rest)
  if (first === 'serve') return (await serve(rest, webRoot))
  if (first === 'storage') return runStorage({ env: process.env, webRoot, home: process.env.HOME ?? '', log, warn }, rest)
  if (first === '-h' || first === '--help' || first === 'help') {
    log('Usage: talaria-web [port] [--host HOST] [--no-browser] [--skip-agent-install] [--foreground]\n       talaria-web serve [args]\n       talaria-web ctl <start|stop|restart|status|logs>\n       talaria-web storage copy --from <json|sqlite|postgres> --to <json|sqlite|postgres>\n       talaria-web storage copy-blobs --from <local|s3> --to <local|s3>\n       talaria-web self-check')
    return 0
  }
  const args = parseBootstrapArgs(argv, process.env)
  const release = loadReleaseInfo({ webRoot })
  return runBootstrap({ env: process.env, webRoot, hermesHome, home, compatibleAgentRevision: release.compatibleAgent.sourceRevision, serveCommand, log }, args, () => serve(['--host', args.host, String(args.port)], webRoot))
}
