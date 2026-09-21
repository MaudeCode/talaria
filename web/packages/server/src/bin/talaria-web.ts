#!/usr/bin/env node
/** `talaria-web`: start the Talaria Web server with the Agent sidecar (launcher subcommands arrive in checkpoint 9). */
import { resolve } from 'node:path'
import { createApp } from '../app.js'
import { loadConfig } from '../config.js'
import { createDeps } from '../runtime.js'
import { startServer } from '../server.js'
import { launchSidecar } from '../sidecar/discover.js'

const webRoot = process.env.TALARIA_WEB_ROOT ?? resolve(import.meta.dirname, '..', '..', '..', '..')
const log = (line: string): void => { console.log(line) }
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
const app = createApp(deps)
const running = await startServer(app, deps.config)
deps.relay.start()
deps.completions.start()
deps.hygiene.start()
console.log(`  Then open:     ${running.scheme}://localhost:${running.port}`)
