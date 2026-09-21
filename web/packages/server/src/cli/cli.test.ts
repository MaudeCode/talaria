import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { homeDotenvKeys, loadLauncherDotenv, loadStartupEnv, parseDotenv } from './dotenv.js'
import { agentDirFromHermesCli, detectSupervisor, parseBootstrapArgs, waitForHealth } from './launcher.js'
import { ctlPaths, parseLaunchBinding, portIsBindable, readState, runCtl, type CtlContext } from './ctl.js'
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
    expect(p).toMatchObject({ hermesHome: join(home, '.hermes'), pidFile: join(home, '.hermes', 'webui.pid'), logFile: join(home, '.hermes', 'webui.log'), stateFile: join(home, '.hermes', 'webui.ctl.env'), stateDir: join(home, '.hermes', 'webui'), worktreeMode: false })
    expect(ctlPaths(makeCtx(home, ['node'], { HERMES_WEBUI_LOG_FILE: 'rel.log' })).logFile.startsWith('/')).toBe(true)
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
    expect(ctx.out.some((l) => l.startsWith('[ctl] Started Hermes WebUI (PID'))).toBe(true)
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
    expect(ctx.out[0]).toBe('● hermes-webui — running')
    expect(ctx.out.find((l) => l.startsWith('  Health:'))).toBe('  Health:  ok (1 sessions, 0 active streams)')
    ctx.out.length = 0
    expect(await runCtl(ctx, ['stop'])).toBe(0)
    expect(ctx.out).toContain('[ctl] Stopped')
    expect(existsSync(p.pidFile)).toBe(false)
    expect(await portIsBindable('127.0.0.1', port)).toBe(true)
    ctx.out.length = 0
    expect(await runCtl(ctx, ['status'])).toBe(0)
    expect(ctx.out[0]).toBe('● hermes-webui — stopped')
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
    expect(ctx.out[0]).toBe('● hermes-webui — running (not managed by talaria-web ctl)')
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
