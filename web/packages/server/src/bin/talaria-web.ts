#!/usr/bin/env node
/** `talaria-web`: start the Talaria Web server (launcher subcommands arrive in checkpoint 9). */
import { resolve } from 'node:path'
import { createApp } from '../app.js'
import { createDeps } from '../runtime.js'
import { startServer } from '../server.js'

const webRoot = process.env.TALARIA_WEB_ROOT ?? resolve(import.meta.dirname, '..', '..', '..', '..')
const deps = createDeps({ webRoot })
const app = createApp(deps)
const running = await startServer(app, deps.config)
console.log(`  Then open:     ${running.scheme}://localhost:${running.port}`)
