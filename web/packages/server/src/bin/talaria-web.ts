#!/usr/bin/env node
/**
 * `talaria-web` (Python `start.sh` + `bootstrap.py` + `ctl.sh`):
 *   talaria-web [port] [--host H] [--no-browser] [--foreground] [--skip-agent-install]   launch (detached unless supervised)
 *   talaria-web serve [launcher args]                                                     run the server (supervised worker; self-update restarts it)
 *   talaria-web ctl <start|stop|restart|status|logs> [...]                                daemon control
 */
import { createApp } from '../app.js'
import { loadConfig } from '../config.js'
import { createDeps } from '../runtime.js'
import { loadReleaseInfo } from '../release.js'
import { startServer } from '../server.js'
import { launchSidecar } from '../sidecar/discover.js'
import { loadStartupEnv } from '../cli/dotenv.js'
import { parseBootstrapArgs, runBootstrap } from '../cli/launcher.js'
import { runCtl } from '../cli/ctl.js'
import { resolveWebRoot } from '../cli/web-root.js'
import { supervise, WORKER_ENV } from '../cli/supervise.js'

const webRoot = process.env.TALARIA_WEB_ROOT ?? resolveWebRoot(import.meta.dirname)
const log = (line: string): void => { console.log(line) }
const warn = (line: string): void => { console.error(line) }
const bin = process.argv[1] ?? ''
const serveCommand = [process.execPath, bin, 'serve']

function applyServeArgs(argv: string[]): void {
  const args = parseBootstrapArgs(argv, process.env)
  process.env.HERMES_WEBUI_HOST = args.host
  process.env.HERMES_WEBUI_PORT = String(args.port)
}

/** The long-lived server: `.env` precedence, Agent sidecar, workers. A supervisor parent respawns the worker after a self-update. */
async function serve(args: string[]): Promise<number> {
  if (process.env[WORKER_ENV] !== '1') return supervise({ command: [...serveCommand, ...args], env: process.env, log })
  // dotenv first so explicit serve arguments (positional port, --host) win over the checkout `.env`.
  const home = process.env.HOME ?? ''
  loadStartupEnv({ env: process.env, webRoot, home, log: warn })
  applyServeArgs(args)
  const config = loadConfig({ webRoot })
  const sidecar = launchSidecar({ env: config.env, hermesHome: config.hermesHome, webRoot, home: config.homeDir, log })
  if (sidecar) {
    try {
      const describe = await sidecar.start()
      log(`[sidecar] ready: agent ${describe.agent_version ?? describe.agent_revision ?? 'unknown'} (${describe.compatible ? 'compatible' : 'incompatible'})`)
    } catch (error) {
      log(`[sidecar] failed to start: ${(error as Error).message}; chat is unavailable until it recovers`)
    }
  }
  const deps = createDeps({ webRoot, sidecar })
  // Every exit path (SIGINT/SIGTERM shutdown, `/api/shutdown`, self-update restart) reaps embedded terminals first.
  process.on('exit', () => { deps.updates.stopAutoApply(); deps.terminals.closeAll({ immediate: true }) })
  process.once('SIGINT', () => { deps.updates.stopAutoApply() })
  process.once('SIGTERM', () => { deps.updates.stopAutoApply() })
  // Renamed root profiles and the active profile's config must be known before the first request (Python read both
  // synchronously at startup); until then local-I/O gates fail closed.
  await deps.profiles.warmRootAliases()
  await Promise.resolve().then(() => deps.agentConfig.read(deps.profileHome(deps.activeProfile()))).catch(() => undefined)
  const app = createApp(deps)
  const running = await startServer(app, deps.config)
  deps.relay.start()
  deps.completions.start()
  deps.hygiene.start()
  deps.updates.startAutoApply()
  log(`  Then open:     ${running.scheme}://localhost:${running.port}`)
  await new Promise<void>(() => undefined)
  return 0
}

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv
  if (first === 'ctl') return runCtl({ env: process.env, webRoot, home: process.env.HOME ?? '', serveCommand, log, warn }, rest)
  if (first === 'serve') return serve(rest)
  if (first === '-h' || first === '--help' || first === 'help') {
    log('Usage: talaria-web [port] [--host HOST] [--no-browser] [--skip-agent-install] [--foreground]\n       talaria-web serve [args]\n       talaria-web ctl <start|stop|restart|status|logs>')
    return 0
  }
  const home = process.env.HOME ?? ''
  const { hermesHome } = loadStartupEnv({ env: process.env, webRoot, home, log: warn })
  const args = parseBootstrapArgs(argv, process.env)
  const release = loadReleaseInfo({ webRoot })
  return runBootstrap({ env: process.env, webRoot, hermesHome, home, compatibleAgentRevision: release.compatibleAgent.sourceRevision, serveCommand, log }, args, async () => { await serve(['--host', args.host, String(args.port)]) })
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  warn(`[bootstrap] ERROR: ${(error as Error).message}`)
  process.exitCode = 1
}
