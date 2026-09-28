import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { homeDotenvKeys, loadLauncherDotenv, loadStartupEnv, parseDotenv } from './dotenv.js'
import { agentDirFromHermesCli, detectSupervisor, parseBootstrapArgs, runBootstrap, waitForHealth } from './launcher.js'
import { ctlPaths, launchdConflictPid, parseLaunchBinding, portIsBindable, readState, runCtl, type CtlContext } from './ctl.js'
import { bootTestServer } from '../test/harness.js'

function scratch(): string {
  const dir = join(tmpdir(), `talaria-cli-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => { resolve(port) }) }) })
}

describe('.env loading', () => {
  it('parses export prefixes, quotes, escapes, comments, and skips shell-readonly names', () => {
    expect(parseDotenv('# c\nexport A=1\nB="x\\ny \\"q\\"" # trailing\nC=\'raw $x\'\nD=plain value # note\nUID=5\n9BAD=1\nE=\n')).toEqual({ A: '1', B: 'x\ny "q"', C: 'raw $x', D: 'plain value', E: '' })
  })
  it('applies the checkout file unconditionally (unless preserved) and the Hermes file only as a fallback', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'repo.env'), 'HERMES_WEBUI_PORT=9999\nONLY_REPO=r\n')
    writeFileSync(join(dir, 'hermes.env'), 'HERMES_WEBUI_PORT=1\nONLY_HERMES=h\nONLY_REPO=h\n')
    const env: Record<string, string | undefined> = { HERMES_WEBUI_PORT: '8787' }
    expect(loadLauncherDotenv({ env, repoEnvFile: join(dir, 'repo.env'), hermesEnvFile: join(dir, 'hermes.env') }).sort()).toEqual(['HERMES_WEBUI_PORT', 'ONLY_HERMES', 'ONLY_REPO'])
    expect(env).toEqual({ HERMES_WEBUI_PORT: '9999', ONLY_REPO: 'r', ONLY_HERMES: 'h' })
    const preserved: Record<string, string | undefined> = { HERMES_WEBUI_PORT: '8787', HERMES_WEBUI_PRESERVE_ENV: '1' }
    loadLauncherDotenv({ env: preserved, repoEnvFile: join(dir, 'repo.env'), hermesEnvFile: null })
    expect(preserved.HERMES_WEBUI_PORT).toBe('8787')
    const off: Record<string, string | undefined> = { HERMES_WEBUI_NO_DOTENV: '1' }
    expect(loadLauncherDotenv({ env: off, repoEnvFile: join(dir, 'repo.env'), hermesEnvFile: null })).toEqual([])
  })
})

describe('startup environment order', () => {
  it('loads the checkout .env before resolving the Hermes home, then that home\'s .env as a fallback', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'web'))
    mkdirSync(join(dir, 'h'))
    writeFileSync(join(dir, 'web', '.env'), `HERMES_HOME=${join(dir, 'h')}\nFROM_REPO=r\n`)
    writeFileSync(join(dir, 'h', '.env'), 'FROM_HERMES=h\nFROM_REPO=ignored\n')
    const env: Record<string, string | undefined> = {}
    expect(loadStartupEnv({ env, webRoot: join(dir, 'web'), home: dir })).toEqual({ hermesHome: join(dir, 'h') })
    expect(env).toEqual({ HERMES_HOME: join(dir, 'h'), FROM_REPO: 'r', FROM_HERMES: 'h', HERMES_WEBUI_HOME_DOTENV_KEYS: 'FROM_HERMES' })
    // Only the Hermes home's own keys are recorded as the default profile's; the checkout .env is deployment config.
    expect([...homeDotenvKeys(env)]).toEqual(['FROM_HERMES'])
    // The supervisor worker inherits the values and loads again: nothing is new to apply, but the marker must survive.
    loadStartupEnv({ env, webRoot: join(dir, 'web'), home: dir })
    expect([...homeDotenvKeys(env)]).toEqual(['FROM_HERMES'])
  })
})

describe('serve argument precedence', () => {
  it('explicit serve arguments win over the checkout .env host and port', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'web'))
    writeFileSync(join(dir, 'web', '.env'), 'HERMES_WEBUI_PORT=9999\nHERMES_WEBUI_HOST=0.0.0.0\n')
    const env: Record<string, string | undefined> = {}
    loadStartupEnv({ env, webRoot: join(dir, 'web'), home: dir })
    const args = parseBootstrapArgs(['8123', '--host', '127.0.0.1'], env)
    env.HERMES_WEBUI_HOST = args.host
    env.HERMES_WEBUI_PORT = String(args.port)
    expect(env).toMatchObject({ HERMES_WEBUI_PORT: '8123', HERMES_WEBUI_HOST: '127.0.0.1' })
    const defaults = parseBootstrapArgs([], { HERMES_WEBUI_PORT: '9999', HERMES_WEBUI_HOST: '0.0.0.0' })
    expect([defaults.port, defaults.host]).toEqual([9999, '0.0.0.0'])
  })
})

describe('launcher', () => {
  it('a detached launch passes the resolved host and port to the worker so a checkout .env cannot override them', async () => {
    const home = scratch()
    mkdirSync(join(home, 'web'), { recursive: true })
    writeFileSync(join(home, 'web', '.env'), 'HERMES_WEBUI_PORT=1\n')
    const port = await freePort()
    // The stand-in worker binds the port it is told on the command line and answers /health.
    const script = `const http=require('node:http');const port=Number(process.argv[process.argv.indexOf('--host')+2]);http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok'}))}).listen(port,'127.0.0.1');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),8000)`
    const logs: string[] = []
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: home, HERMES_HOME: join(home, '.hermes'), HERMES_WEBUI_SIDECAR_COMMAND: 'x', HERMES_WEBUI_STATE_DIR: join(home, 'state') }
    const code = await runBootstrap({ env, webRoot: join(home, 'web'), hermesHome: join(home, '.hermes'), home, compatibleAgentRevision: 'x', serveCommand: [process.execPath, '-e', script, '--'], log: (l) => logs.push(l) }, { port, host: '127.0.0.1', noBrowser: true, skipAgentInstall: true, foreground: false }, () => Promise.resolve())
    expect(code).toBe(0)
    expect(logs.some((l) => l.includes(`127.0.0.1:${String(port)}`))).toBe(true)
  }, 20_000)

  it('a wildcard IPv6 bind prints a connectable, bracket-correct ready URL', async () => {
    const home = scratch()
    mkdirSync(join(home, 'web'), { recursive: true })
    const port = await freePort()
    const script = `const http=require('node:http');const port=Number(process.argv[process.argv.indexOf('--host')+2]);http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok'}))}).listen(port,'::');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),8000)`
    const logs: string[] = []
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: home, HERMES_HOME: join(home, '.hermes'), HERMES_WEBUI_SIDECAR_COMMAND: 'x', HERMES_WEBUI_STATE_DIR: join(home, 'state') }
    const code = await runBootstrap({ env, webRoot: join(home, 'web'), hermesHome: join(home, '.hermes'), home, compatibleAgentRevision: 'x', serveCommand: [process.execPath, '-e', script, '--'], log: (l) => logs.push(l) }, { port, host: '::', noBrowser: true, skipAgentInstall: true, foreground: false }, () => Promise.resolve())
    expect(code).toBe(0)
    const ready = logs.find((l) => l.includes('Web UI is ready'))
    expect(ready).toContain(`http://localhost:${String(port)}`)
    expect(logs.some((l) => l.includes(`http://:::${String(port)}`))).toBe(false)
  }, 20_000)

  it('the foreground start line brackets an IPv6 host too', async () => {
    const home = scratch()
    mkdirSync(join(home, 'web'), { recursive: true })
    const logs: string[] = []
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: home, HERMES_HOME: join(home, '.hermes'), HERMES_WEBUI_SIDECAR_COMMAND: 'x', HERMES_WEBUI_STATE_DIR: join(home, 'state') }
    const code = await runBootstrap({ env, webRoot: join(home, 'web'), hermesHome: join(home, '.hermes'), home, compatibleAgentRevision: 'x', serveCommand: [process.execPath, '-e', '', '--'], log: (l) => logs.push(l) }, { port: 8787, host: '::', noBrowser: true, skipAgentInstall: true, foreground: true }, () => Promise.resolve())
    expect(code).toBe(0)
    expect(logs.some((l) => l.includes('http://[::]:8787') && l.includes('foreground'))).toBe(true)
    expect(logs.some((l) => l.includes('http://:::8787'))).toBe(false)
  })

  it('parses the bootstrap arguments and detects supervisors like bootstrap.py', () => {
    expect(parseBootstrapArgs(['9000', '--host', '0.0.0.0', '--no-browser', '--foreground'], {})).toEqual({ port: 9000, host: '0.0.0.0', noBrowser: true, skipAgentInstall: false, foreground: true })
    expect(parseBootstrapArgs([], { HERMES_WEBUI_PORT: '8790', HERMES_WEBUI_HOST: '::' })).toMatchObject({ port: 8790, host: '::' })
    expect(() => parseBootstrapArgs(['--bogus'], {})).toThrow('unknown argument')
    expect(detectSupervisor({ INVOCATION_ID: 'abc' })).toBe('INVOCATION_ID')
    expect(detectSupervisor({ XPC_SERVICE_NAME: '0' })).toBeNull()
    expect(detectSupervisor({ XPC_SERVICE_NAME: 'application.com.apple.Terminal.X' })).toBeNull()
    expect(detectSupervisor({ XPC_SERVICE_NAME: 'com.example.hermes' })).toBe('XPC_SERVICE_NAME')
    expect(detectSupervisor({ HERMES_WEBUI_FOREGROUND: 'yes' })).toBe('HERMES_WEBUI_FOREGROUND')
    expect(detectSupervisor({})).toBeNull()
  })
  it('recovers the Agent checkout from the hermes launcher wrapper', () => {
    const dir = scratch()
    const agent = join(dir, 'opt', 'hermes-agent')
    mkdirSync(join(agent, 'venv', 'bin'), { recursive: true })
    writeFileSync(join(agent, 'run_agent.py'), '')
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'hermes'), `#!/usr/bin/env bash\nexec "${join(agent, 'venv', 'bin', 'hermes')}" "$@"\n`)
    expect(agentDirFromHermesCli({ PATH: join(dir, 'bin') })).toBe(agent)
    writeFileSync(join(dir, 'bin', 'hermes'), `#!${join(agent, 'venv', 'bin', 'python3')}\nprint(1)\n`)
    expect(agentDirFromHermesCli({ PATH: join(dir, 'bin') })).toBe(agent)
    writeFileSync(join(dir, 'bin', 'hermes'), 'not a script')
    expect(agentDirFromHermesCli({ PATH: join(dir, 'bin') })).toBeNull()
  })
  it('waits for /health on the running server and gives up on a closed port', async () => {
    const s = await bootTestServer()
    try {
      expect(await waitForHealth('127.0.0.1', s.running.port, { tls: false, insecureOptIn: false, timeoutMs: 5000, log: () => undefined })).toBe('http')
      const closed = await freePort()
      expect(await waitForHealth('127.0.0.1', closed, { tls: false, insecureOptIn: false, timeoutMs: 600, log: () => undefined })).toBe('')
    } finally { await s.close() }
  })
})

describe('ctl', () => {
  const fakeServe = (script: string): string[] => [process.execPath, '-e', script, '--']
  const stops: (() => Promise<void>)[] = []
  afterEach(async () => { for (const stop of stops.splice(0)) await stop() })

  function makeCtx(home: string, serveCommand: string[], extraEnv: Record<string, string> = {}): CtlContext & { out: string[]; err: string[] } {
    const out: string[] = []
    const err: string[] = []
    const webRoot = join(home, 'checkout', 'web')
    mkdirSync(webRoot, { recursive: true })
    return { env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: join(home, '.hermes'), HERMES_WEBUI_CTL_ISOLATE_WORKTREE: '0', ...extraEnv }, webRoot, home, serveCommand, log: (l) => out.push(l), warn: (l) => err.push(l), out, err }
  }

  it('resolves the ctl files under the Hermes home and parses the launch binding', () => {
    const home = scratch()
    const ctx = makeCtx(home, ['node'])
    const p = ctlPaths(ctx)
    expect(p).toMatchObject({ hermesHome: join(home, '.hermes'), pidFile: join(home, '.hermes', 'webui.pid'), logFile: join(home, '.hermes', 'webui.log'), stateFile: join(home, '.hermes', 'webui.ctl.env'), stateDir: join(home, '.hermes', 'webui'), worktreeMode: false, launchdLabels: ['dev.kil.talaria.web', 'com.parantoux.hermes-webui'] })
    expect(ctlPaths(makeCtx(home, ['node'], { HERMES_WEBUI_LOG_FILE: 'rel.log' })).logFile.startsWith('/')).toBe(true)
    expect(ctlPaths(makeCtx(home, ['node'], { HERMES_WEBUI_LAUNCHD_LABEL: 'com.example.custom' })).launchdLabels).toEqual(['com.example.custom'])
    expect(parseLaunchBinding(['9001', '--host', '0.0.0.0', '--skip-agent-install', 'x'], {})).toEqual({ host: '0.0.0.0', port: 9001, portExplicit: true, passthrough: ['--skip-agent-install', 'x'] })
    expect(parseLaunchBinding([], { HERMES_WEBUI_CTL_PORT_START: '9100' })).toMatchObject({ port: 9100, portExplicit: false })
  })

  it('starts a daemon, reports status, refuses a duplicate, and stops it', async () => {
    const home = scratch()
    const port = await freePort()
    // A stand-in server that honours the launcher argument protocol and answers /health.
    const script = `const http=require('node:http');const port=Number(process.argv[process.argv.indexOf('--host')+2]);http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',sessions:1,active_streams:0}))}).listen(port,'127.0.0.1');setInterval(()=>{},1000)`
    const ctx = makeCtx(home, fakeServe(script))
    const code = await runCtl(ctx, ['start', String(port)])
    stops.push(async () => { await runCtl(ctx, ['stop']) })
    expect(code).toBe(0)
    expect(ctx.out.some((l) => l.startsWith('[ctl] Started Talaria Web (PID'))).toBe(true)
    expect(ctx.out).toContain(`HERMES_WEBUI_PORT=${String(port)}`)
    const p = ctlPaths(ctx)
    expect(existsSync(p.pidFile)).toBe(true)
    const state = readState(p)
    expect(state).toMatchObject({ REPO_ROOT: ctx.webRoot, HOST: '127.0.0.1', PORT: String(port), LOG_FILE: p.logFile, STATE_DIR: p.stateDir })
    expect(readFileSync(p.pidFile, 'utf8').trim()).toBe(state.PID)
    expect(readFileSync(p.stateFile, 'utf8')).toContain('STARTED_AT=')
    // Second start is a no-op that prints the coordinates.
    ctx.out.length = 0
    expect(await runCtl(ctx, ['start', String(port)])).toBe(0)
    expect(ctx.out[0]).toMatch(/already running/)
    ctx.out.length = 0
    expect(await runCtl(ctx, ['status'])).toBe(0)
    expect(ctx.out[0]).toBe('● talaria-web — running')
    expect(ctx.out.find((l) => l.startsWith('  Health:'))).toBe('  Health:  ok (1 sessions, 0 active streams)')
    ctx.out.length = 0
    expect(await runCtl(ctx, ['stop'])).toBe(0)
    expect(ctx.out).toContain('[ctl] Stopped')
    expect(existsSync(p.pidFile)).toBe(false)
    expect(await portIsBindable('127.0.0.1', port)).toBe(true)
    ctx.out.length = 0
    expect(await runCtl(ctx, ['status'])).toBe(0)
    expect(ctx.out[0]).toBe('● talaria-web — stopped')
  })

  it('stop, status, and logs resolve the daemon through the checkout .env like start does', async () => {
    const home = scratch()
    const port = await freePort()
    const script = `const http=require('node:http');const port=Number(process.argv[process.argv.indexOf('--host')+2]);http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',sessions:0,active_streams:0}))}).listen(port,'127.0.0.1');setInterval(()=>{},1000)`
    const ctx = makeCtx(home, fakeServe(script))
    // The checkout .env relocates the Hermes home; every subcommand must read it, not only `start`.
    const relocated = join(home, 'elsewhere')
    mkdirSync(relocated, { recursive: true })
    writeFileSync(join(ctx.webRoot, '.env'), `HERMES_HOME=${relocated}\n`)
    delete ctx.env.HERMES_HOME
    expect(await runCtl(ctx, ['start', String(port)])).toBe(0)
    stops.push(async () => { await runCtl(ctx, ['stop']) })
    expect(existsSync(join(relocated, 'webui.pid'))).toBe(true)
    const fresh = makeCtx(home, fakeServe(script))
    delete fresh.env.HERMES_HOME
    expect(await runCtl(fresh, ['status'])).toBe(0)
    expect(fresh.out[0]).toBe('● talaria-web — running')
    const stopper = makeCtx(home, fakeServe(script))
    delete stopper.env.HERMES_HOME
    expect(await runCtl(stopper, ['stop'])).toBe(0)
    expect(stopper.out).toContain('[ctl] Stopped')
    expect(existsSync(join(relocated, 'webui.pid'))).toBe(false)
    expect(await portIsBindable('127.0.0.1', port)).toBe(true)
  })

  it('refuses to start when a foreign server already answers on the port and warns on stop', async () => {
    const home = scratch()
    const s = await bootTestServer()
    stops.push(() => s.close())
    const ctx = makeCtx(home, fakeServe('setInterval(()=>{},1000)'))
    expect(await runCtl(ctx, ['start', String(s.running.port)])).toBe(2)
    expect(ctx.err[0]).toContain('a live server is already responding on 127.0.0.1:')
    expect(existsSync(ctlPaths(ctx).pidFile)).toBe(false)
    ctx.env.HERMES_WEBUI_PORT = String(s.running.port)
    expect(await runCtl(ctx, ['stop'])).toBe(0)
    expect(ctx.err.some((l) => l.includes('NOT managed by talaria-web ctl'))).toBe(true)
    ctx.out.length = 0
    expect(await runCtl(ctx, ['status'])).toBe(0)
    expect(ctx.out[0]).toBe('● talaria-web — running (not managed by talaria-web ctl)')
  })

  it('detects a launchd job still under the legacy default label unless a label override is set', async () => {
    const home = scratch()
    // Stand-in launchd job: this test process listens on the wanted port; a fake launchctl knows only the legacy label.
    const listener = createServer()
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done))
    stops.push(() => new Promise<void>((done) => listener.close(() => { done() })))
    const port = (listener.address() as { port: number }).port
    const bin = join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'launchctl'), `#!/bin/sh\ncase "$2" in */com.parantoux.hermes-webui) printf '\\tpid = ${String(process.pid)}\\n'; exit 0;; esac\nexit 113\n`, { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}:${savedPath ?? ''}`
    try {
      const ctx = makeCtx(home, ['node'])
      expect(launchdConflictPid(ctlPaths(ctx), ctx.env, port)).toEqual({ pid: process.pid, label: 'com.parantoux.hermes-webui' })
      const custom = makeCtx(home, ['node'], { HERMES_WEBUI_LAUNCHD_LABEL: 'com.example.custom' })
      expect(launchdConflictPid(ctlPaths(custom), custom.env, port)).toBeNull()
    } finally { process.env.PATH = savedPath }
  })

  it('reports a server that dies during the startup grace window', async () => {
    const home = scratch()
    const ctx = makeCtx(home, fakeServe('process.exit(3)'), { HERMES_WEBUI_START_GRACE: '1' })
    expect(await runCtl(ctx, ['start', String(await freePort())])).toBe(1)
    expect(ctx.err[0]).toContain('failed to stay running')
    expect(existsSync(ctlPaths(ctx).pidFile)).toBe(false)
    expect(await runCtl(ctx, ['bogus'])).toBe(2)
    expect(await runCtl(ctx, ['logs', '--lines', 'x'])).toBe(2)
  })
})

describe('npm package contents', () => {
  it('ships every tree the installed server resolves through the Web root, including the brand assets', () => {
    // `npm pack --dry-run` runs prepack/postpack, so this checks both the copy set and the `files` allowlist.
    const pkg = join(import.meta.dirname, '..', '..')
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkg, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const files = new Set((JSON.parse(out) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path))
    for (const required of ['LICENSE', 'static/dist/THIRD_PARTY_LICENSES.md', 'static/dist/index.html', 'static/brand/favicon.ico', 'static/brand/brandmark.svg', 'static/brand/favicon-192.png', 'sidecar/agent_dependency.json', 'sidecar/talaria_sidecar/__main__.py', 'contract_versions.json']) {
      expect(files.has(required), required).toBe(true)
    }
  })
})
