import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as atomic from '../fs/atomic.js'
import { loadStartupEnv } from './dotenv.js'
import { DUPLICATE_SIGNAL_MS, RESTART_EXIT_CODE, RUN_DRAIN_MS, RUN_SETTLE_MS, supervise, watchRetirement, WORKER_SHUTDOWN_MS, STOP_GRACE_MS } from './supervise.js'

const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const
const baseline = new Map(STOP_SIGNALS.map((signal) => [signal, process.listenerCount(signal)]))
const roots: string[] = []
// Test-owned processes only, killed by exact PID.
const owned: number[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const pid of owned.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  // Every supervisor run removes its signal handlers once its worker exits.
  for (const signal of STOP_SIGNALS) expect(process.listenerCount(signal)).toBe(baseline.get(signal))
})

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

function bindable(port: number): Promise<boolean> {
  const server = createServer()
  return new Promise((resolve) => {
    server.once('error', () => { resolve(false) })
    server.listen(port, '127.0.0.1', () => server.close(() => { resolve(true) }))
  })
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const lines = (file: string): string[] => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
const DIST_SUPERVISE = join(import.meta.dirname, '../../dist/cli/supervise.js')
const DIST_BIN = join(import.meta.dirname, '../../dist/bin/talaria-web.js')

function fixture(mode: 'before-ready' | 'after-ready' | 'no-marker' | 'restored-crash' | 'retry' | 'newer-update' | 'restored-restart') {
  const root = mkdtempSync(join(tmpdir(), 'talaria-supervise-'))
  roots.push(root)
  const packageRoot = join(root, '@maudecode/talaria-web')
  const previous = join(dirname(packageRoot), '.talaria-web-previous')
  const failed = join(dirname(packageRoot), '.talaria-web-failed')
  const stateDir = join(root, 'state')
  const marker = join(stateDir, 'update-rollback.json')
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(previous)
  mkdirSync(failed)
  writeFileSync(join(failed, 'obsolete'), 'previous failed package')
  mkdirSync(stateDir)
  writeFileSync(join(packageRoot, 'version'), '2.0.0')
  writeFileSync(join(previous, 'version'), '1.0.0')
  const count = join(root, 'count')
  // The initial worker requests a restart; subsequent workers load whichever package is on disk.
  const script = `
    const fs = require('node:fs');
    const paths = ${JSON.stringify({ count, marker, packageRoot, previous })};
    const mode = ${JSON.stringify(mode)};
    const n = fs.existsSync(paths.count) ? Number(fs.readFileSync(paths.count)) : 0;
    fs.writeFileSync(paths.count, String(n + 1));
    if (n === 0) {
      if (mode !== 'no-marker') fs.writeFileSync(paths.marker, JSON.stringify({
        version: '2.0.0', previousVersion: '1.0.0', ...(mode === 'retry' ? { failedVersion: '2.0.0' } : {})
      }));
      process.exit(${String(RESTART_EXIT_CODE)});
    }
    const old = fs.readFileSync(paths.packageRoot + '/version', 'utf8') === '1.0.0';
    if (old && mode === 'newer-update' && n === 2) {
      process.send('ready', () => {
        fs.renameSync(paths.packageRoot, paths.previous);
        fs.mkdirSync(paths.packageRoot);
        fs.writeFileSync(paths.packageRoot + '/version', '3.0.0');
        fs.writeFileSync(paths.marker, JSON.stringify({ version: '3.0.0', previousVersion: '1.0.0' }));
        process.exit(${String(RESTART_EXIT_CODE)});
      });
    } else if (old && mode === 'restored-restart' && n === 2) {
      process.send('ready', () => process.exit(${String(RESTART_EXIT_CODE)}));
    } else if (mode === 'after-ready' || mode === 'retry' || (old && mode !== 'restored-crash')) {
      if (!process.send) process.exit(9);
      process.send('ready', () => { process.disconnect(); process.exit(old ? 4 : 3); });
    } else process.exit(old ? 4 : 3);
  `
  const lines: string[] = []
  const run = () => supervise({ command: [process.execPath, '-e', script], env: process.env, log: (line) => lines.push(line), restartDelayMs: 0, packageRoot, stateDir })
  return { packageRoot, previous, failed, marker, count, lines, run }
}

describe('self-update startup rollback', () => {
  it('restores the previous package and respawns once after a crash before ready', async () => {
    const f = fixture('before-ready')
    expect(await f.run()).toBe(4)
    expect(readFileSync(join(f.packageRoot, 'version'), 'utf8')).toBe('1.0.0')
    expect(readFileSync(join(dirname(f.packageRoot), '.talaria-web-failed/version'), 'utf8')).toBe('2.0.0')
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toEqual({ version: '2.0.0', previousVersion: '1.0.0', failedVersion: '2.0.0' })
    expect(readFileSync(f.count, 'utf8')).toBe('3')
    expect(f.lines).toContain('[serve] update to 2.0.0 failed to start; restored 1.0.0')
  })

  it.each(['before-ready', 'restored-crash'] as const)('starts the restored worker once when the failure record cannot be persisted (%s)', async (mode) => {
    const f = fixture(mode)
    vi.spyOn(atomic, 'atomicWriteText').mockImplementation(() => { throw new Error('synthetic full filesystem') })
    expect(await f.run()).toBe(4)
    expect(readFileSync(join(f.packageRoot, 'version'), 'utf8')).toBe('1.0.0')
    expect(readFileSync(f.count, 'utf8')).toBe('3')
    expect(f.lines).toContain('[serve] could not persist failed update: synthetic full filesystem')
    expect(f.lines).toContain('[serve] update to 2.0.0 failed to start; restored 1.0.0')
  })

  it('keeps the new package and clears the marker after ready, even if it then crashes', async () => {
    const f = fixture('after-ready')
    expect(await f.run()).toBe(3)
    expect(readFileSync(join(f.packageRoot, 'version'), 'utf8')).toBe('2.0.0')
    expect(existsSync(f.previous)).toBe(true)
    expect(existsSync(f.marker)).toBe(false)
    expect(existsSync(f.failed)).toBe(false)
  })

  it('exits normally when there is no rollback marker', async () => {
    const f = fixture('no-marker')
    expect(await f.run()).toBe(3)
    expect(readFileSync(f.count, 'utf8')).toBe('2')
  })

  it('exits after the restored worker crashes without looping', async () => {
    const f = fixture('restored-crash')
    expect(await f.run()).toBe(4)
    expect(readFileSync(f.count, 'utf8')).toBe('3')
  })

  it('can recover a later update after the restored worker becomes ready', async () => {
    const f = fixture('newer-update')
    expect(await f.run()).toBe(4)
    expect(readFileSync(f.count, 'utf8')).toBe('5')
    expect(readFileSync(join(f.packageRoot, 'version'), 'utf8')).toBe('1.0.0')
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toEqual({ version: '3.0.0', previousVersion: '1.0.0', failedVersion: '3.0.0' })
  })

  it('retains the failed-version record and quarantine when the restored worker later restarts', async () => {
    const f = fixture('restored-restart')
    expect(await f.run()).toBe(4)
    expect(readFileSync(f.count, 'utf8')).toBe('4')
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toEqual({ version: '2.0.0', previousVersion: '1.0.0', failedVersion: '2.0.0' })
    expect(existsSync(f.failed)).toBe(true)
  })

  it('clears a failed-version record when a manual retry starts successfully', async () => {
    const f = fixture('retry')
    expect(await f.run()).toBe(3)
    expect(existsSync(f.marker)).toBe(false)
    expect(existsSync(f.failed)).toBe(false)
  })
})

describe('supervisor worker environment', () => {
  it.each(['rotated', 'deleted'] as const)('reloads a %s home credential after restart while preserving operator variables', async (change) => {
    const root = mkdtempSync(join(tmpdir(), 'talaria-supervise-env-'))
    roots.push(root)
    const home = join(root, 'home')
    const webRoot = join(root, 'web')
    const observed = join(root, 'observed.json')
    mkdirSync(home)
    mkdirSync(webRoot)
    const dotenv = join(home, '.env')
    writeFileSync(dotenv, 'SYNTHETIC_HOME_TOKEN=old\nSYNTHETIC_OPERATOR_TOKEN=from-file\n')
    const env: NodeJS.ProcessEnv = { ...process.env, HERMES_HOME: home, HERMES_WEBUI_NO_DOTENV: '0', SYNTHETIC_OPERATOR_TOKEN: 'operator' }
    delete env.SYNTHETIC_HOME_TOKEN
    delete env.HERMES_WEBUI_HOME_DOTENV_KEYS
    loadStartupEnv({ env, webRoot, home: root })
    const script = `
      const fs = require('node:fs');
      const { loadStartupEnv } = require(${JSON.stringify(join(import.meta.dirname, '../../dist/cli/dotenv.js'))});
      loadStartupEnv({ env: process.env, webRoot: ${JSON.stringify(webRoot)}, home: ${JSON.stringify(root)} });
      const observed = ${JSON.stringify(observed)};
      const values = fs.existsSync(observed) ? JSON.parse(fs.readFileSync(observed)) : [];
      values.push({ home: process.env.SYNTHETIC_HOME_TOKEN ?? null, operator: process.env.SYNTHETIC_OPERATOR_TOKEN });
      fs.writeFileSync(observed, JSON.stringify(values));
      if (values.length === 1) {
        fs.writeFileSync(${JSON.stringify(dotenv)}, ${JSON.stringify(change === 'rotated' ? 'SYNTHETIC_HOME_TOKEN=new\nSYNTHETIC_OPERATOR_TOKEN=changed-file\n' : 'SYNTHETIC_OPERATOR_TOKEN=changed-file\n')});
        process.exit(${String(RESTART_EXIT_CODE)});
      }
      process.exit(3);
    `
    expect(await supervise({ command: [process.execPath, '-e', script], env, log: () => undefined, restartDelayMs: 0 })).toBe(3)
    expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual([
      { home: 'old', operator: 'operator' },
      { home: change === 'rotated' ? 'new' : null, operator: 'operator' },
    ])
    expect(env.SYNTHETIC_HOME_TOKEN).toBe('old')
  })
})

/**
 * A synthetic worker owning a disposable loopback port. It records each spawn and each stop signal it receives;
 * `cooperate` closes the listener and exits on the first signal, `ignore` keeps serving.
 */
function portWorker(port: number, onStop: 'cooperate' | 'ignore', closeDelayMs = 0) {
  const root = tempRoot('talaria-supervise-port-')
  const files = { spawns: join(root, 'spawns'), signals: join(root, 'signals'), ready: join(root, 'ready'), error: join(root, 'error') }
  const script = `
    const fs = require('node:fs');
    const files = ${JSON.stringify(files)};
    fs.appendFileSync(files.spawns, process.pid + '\\n');
    const server = require('node:net').createServer((socket) => socket.end()).listen(${String(port)}, '127.0.0.1', () => fs.appendFileSync(files.ready, process.pid + '\\n'));
    // An ignoring worker stays alive even when it could not bind.
    server.on('error', (error) => { fs.writeFileSync(files.error, error.code); if (${JSON.stringify(onStop)} === 'cooperate') process.exit(1); else setInterval(() => undefined, 1000); });
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {
      fs.appendFileSync(files.signals, signal + '\\n');
      if (${JSON.stringify(onStop)} === 'cooperate') setTimeout(() => server.close(() => process.exit(0)), ${String(closeDelayMs)});
    });
  `
  return { files, command: [process.execPath, '-e', script] }
}

describe('supervisor stop', () => {
  it('releases the port and reaps the worker before a successor starts', async () => {
    const port = await freePort()
    const worker = portWorker(port, 'cooperate')
    const first = supervise({ command: worker.command, env: process.env, log: () => undefined, restartDelayMs: 0 })
    expect(await until(() => lines(worker.files.ready).length === 1, 10_000)).toBe(true)
    const [pid] = lines(worker.files.spawns).map(Number)
    owned.push(pid!)
    process.emit('SIGTERM', 'SIGTERM')
    expect(await first).toBe(0)
    expect(alive(pid!)).toBe(false)
    expect(await bindable(port)).toBe(true)
    const successor = supervise({ command: worker.command, env: process.env, log: () => undefined, restartDelayMs: 0 })
    expect(await until(() => lines(worker.files.ready).length === 2, 10_000)).toBe(true)
    owned.push(Number(lines(worker.files.spawns)[1]))
    process.emit('SIGTERM', 'SIGTERM')
    expect(await successor).toBe(0)
    expect(lines(worker.files.spawns)).toHaveLength(2)
  })

  it('kills a worker that ignores the stop signal after the grace deadline', async () => {
    const port = await freePort()
    const worker = portWorker(port, 'ignore')
    const log: string[] = []
    const run = supervise({ command: worker.command, env: process.env, log: (line) => log.push(line), restartDelayMs: 0, stopGraceMs: 300 })
    expect(await until(() => lines(worker.files.ready).length === 1, 10_000)).toBe(true)
    const [pid] = lines(worker.files.spawns).map(Number)
    owned.push(pid!)
    process.emit('SIGTERM', 'SIGTERM')
    const outcome = await Promise.race([run, new Promise((resolve) => setTimeout(() => { resolve('supervisor still waiting for its worker') }, 5000))])
    if (outcome !== 137) process.kill(pid!, 'SIGKILL')
    expect(outcome).toBe(137)
    expect(lines(worker.files.signals)).toEqual(['SIGTERM'])
    expect(lines(worker.files.spawns)).toHaveLength(1)
    expect(alive(pid!)).toBe(false)
    expect(await bindable(port)).toBe(true)
    expect(log).toContain(`[serve] worker ${String(pid)} did not exit within 300 ms of SIGTERM; killing it`)
  })

  it('forwards only the first of repeated stop signals', async () => {
    const port = await freePort()
    const worker = portWorker(port, 'cooperate', 300)
    const run = supervise({ command: worker.command, env: process.env, log: () => undefined, restartDelayMs: 0 })
    expect(await until(() => lines(worker.files.ready).length === 1, 10_000)).toBe(true)
    owned.push(Number(lines(worker.files.spawns)[0]))
    for (const signal of ['SIGTERM', 'SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.emit(signal, signal)
    expect(await run).toBe(0)
    expect(lines(worker.files.signals)).toEqual(['SIGTERM'])
    expect(await bindable(port)).toBe(true)
  })

  it('returns when the worker cannot be spawned', async () => {
    const log: string[] = []
    expect(await supervise({ command: [join(tempRoot('talaria-supervise-missing-'), 'missing-worker')], env: process.env, log: (line) => log.push(line), restartDelayMs: 0 })).toBe(1)
    expect(log.some((line) => line.startsWith('[serve] worker failed to start:'))).toBe(true)
  })

  it('kills only its own worker when a foreign process holds the port', async () => {
    const port = await freePort()
    const root = tempRoot('talaria-supervise-foreign-')
    const foreignReady = join(root, 'ready')
    const foreign: ChildProcess = spawn(process.execPath, ['-e', `require('node:net').createServer((s) => s.end()).listen(${String(port)}, '127.0.0.1', () => require('node:fs').writeFileSync(${JSON.stringify(foreignReady)}, ''))`], { stdio: 'ignore' })
    owned.push(foreign.pid!)
    expect(await until(() => existsSync(foreignReady), 10_000)).toBe(true)
    const worker = portWorker(port, 'ignore')
    const run = supervise({ command: worker.command, env: process.env, log: () => undefined, restartDelayMs: 0, stopGraceMs: 300 })
    expect(await until(() => existsSync(worker.files.error), 10_000)).toBe(true)
    expect(readFileSync(worker.files.error, 'utf8')).toBe('EADDRINUSE')
    const [pid] = lines(worker.files.spawns).map(Number)
    owned.push(pid!)
    process.emit('SIGTERM', 'SIGTERM')
    expect(await run).toBe(137)
    expect(alive(pid!)).toBe(false)
    expect(alive(foreign.pid!)).toBe(true)
    expect(await bindable(port)).toBe(false)
  })
})

describe('supervisor loss', () => {
  function isolatedEnv(root: string): NodeJS.ProcessEnv {
    // Disposable state, no network update checks, and a scripted sidecar that exits at once: no Agent is involved.
    return {
      PATH: process.env.PATH, HOME: root, HERMES_HOME: join(root, 'agent-home'), HERMES_WEBUI_STATE_DIR: join(root, 'state'),
      HERMES_WEBUI_DEFAULT_WORKSPACE: join(root, 'workspace'), HERMES_WEBUI_CLAUDE_PROJECTS_DIR: join(root, 'claude-projects'),
      HERMES_WEBUI_NO_DOTENV: '1', HERMES_WEBUI_TEST_NETWORK_BLOCK: '1', HERMES_WEBUI_SIDECAR_COMMAND: JSON.stringify([process.execPath, '-e', '']),
    }
  }

  it('retires the real serve worker after ready when its supervisor is killed abruptly', async () => {
    const root = tempRoot('talaria-supervise-orphan-')
    const port = await freePort()
    const supervisor = spawn(process.execPath, [DIST_BIN, 'serve', '--host', '127.0.0.1', String(port)], { env: isolatedEnv(root), stdio: 'ignore' })
    owned.push(supervisor.pid!)
    const healthy = () => fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(1000) }).then((res) => res.ok, () => false)
    expect(await until(healthy, 15_000)).toBe(true)
    const worker = Number(execFileSync('pgrep', ['-P', String(supervisor.pid)], { encoding: 'utf8' }).trim())
    owned.push(worker)
    supervisor.kill('SIGKILL')
    expect(await until(() => !alive(worker), 8000) ? 'worker exited' : 'orphaned worker still running').toBe('worker exited')
    expect(await bindable(port)).toBe(true)
  })

  it('keeps serving a worker run directly without a supervisor, and stops it on SIGTERM', async () => {
    const root = tempRoot('talaria-supervise-direct-')
    const port = await freePort()
    const worker = spawn(process.execPath, [DIST_BIN, 'serve', '--host', '127.0.0.1', String(port)], { env: { ...isolatedEnv(root), TALARIA_WEB_WORKER: '1' }, stdio: 'ignore' })
    owned.push(worker.pid!)
    const exited = new Promise<number | null>((resolve) => worker.once('exit', resolve))
    const healthy = () => fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(1000) }).then((res) => res.ok, () => false)
    expect(await until(healthy, 15_000)).toBe(true)
    worker.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(await bindable(port)).toBe(true)
  })

  it('retires a worker still starting when its supervisor is killed abruptly, and a replacement binds the port', async () => {
    const root = tempRoot('talaria-supervise-startup-')
    const port = await freePort()
    const files = { pid: join(root, 'pid'), bound: join(root, 'bound') }
    // Binds the port, then never finishes startup: retirement has no close path attached yet.
    const workerScript = `
      const fs = require('node:fs');
      const { watchRetirement } = require(${JSON.stringify(DIST_SUPERVISE)});
      watchRetirement({ log: () => undefined, supervised: true });
      fs.writeFileSync(${JSON.stringify(files.pid)}, String(process.pid));
      require('node:net').createServer().listen(${String(port)}, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(files.bound)}, ''));
    `
    const supervisorScript = `
      import(${JSON.stringify(DIST_SUPERVISE)}).then(({ supervise }) => supervise({ command: [process.execPath, '-e', ${JSON.stringify(workerScript)}], env: process.env, log: () => undefined }));
    `
    const supervisor = spawn(process.execPath, ['-e', supervisorScript], { stdio: 'ignore' })
    owned.push(supervisor.pid!)
    expect(await until(() => existsSync(files.bound), 10_000)).toBe(true)
    const worker = Number(readFileSync(files.pid, 'utf8'))
    owned.push(worker)
    supervisor.kill('SIGKILL')
    expect(await until(() => !alive(worker), 8000) ? 'worker exited' : 'orphaned worker still running').toBe('worker exited')
    const replacement = portWorker(port, 'cooperate')
    const run = supervise({ command: replacement.command, env: process.env, log: () => undefined, restartDelayMs: 0 })
    expect(await until(() => lines(replacement.files.ready).length === 1, 10_000)).toBe(true)
    owned.push(Number(lines(replacement.files.spawns)[0]))
    process.emit('SIGTERM', 'SIGTERM')
    expect(await run).toBe(0)
  })
})

describe('worker retirement policy', () => {
  function retirement(opts: { connected?: boolean; supervised?: boolean; deadlineMs?: number } = {}) {
    vi.useFakeTimers()
    const events = Object.assign(new EventEmitter(), { connected: opts.connected ?? true })
    const exit = vi.fn<(code: number) => void>()
    const log: string[] = []
    const r = watchRetirement({ log: (line) => log.push(line), supervised: opts.supervised ?? true, deadlineMs: opts.deadlineMs ?? 1000, exit, events })
    return { events, exit, log, r }
  }
  afterEach(() => { vi.useRealTimers() })

  it('leaves the worker room to finish inside the supervisor grace', () => {
    expect(WORKER_SHUTDOWN_MS).toBeLessThan(STOP_GRACE_MS)
  })

  it('drains and settles local runs with a margin left before the worker deadline (TAL-1628)', () => {
    expect(RUN_DRAIN_MS + RUN_SETTLE_MS).toBeLessThan(WORKER_SHUTDOWN_MS)
  })

  it('escalates once on a stop signal repeated after the duplicate window, never on a duplicate delivery (TAL-1628)', async () => {
    const { events, exit, log, r } = retirement({ deadlineMs: WORKER_SHUTDOWN_MS })
    let finish!: () => void
    const close = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const escalate = vi.fn()
    r.attach(close, escalate)
    events.emit('SIGINT')
    events.emit('SIGINT')
    await vi.advanceTimersByTimeAsync(DUPLICATE_SIGNAL_MS - 1)
    events.emit('SIGTERM')
    expect(escalate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) events.emit(signal)
    expect(escalate).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(exit.mock.calls).toEqual([[0]])
    expect(log).toEqual(['[webui] SIGINT received; shutting down', '[webui] SIGINT received again; interrupting local runs now'])
  })

  it('does not escalate supervisor loss or a retirement before the close path exists', async () => {
    const { events, exit, r } = retirement({ deadlineMs: WORKER_SHUTDOWN_MS })
    const escalate = vi.fn()
    r.attach(() => new Promise<void>(() => undefined), escalate)
    events.emit('disconnect')
    await vi.advanceTimersByTimeAsync(DUPLICATE_SIGNAL_MS)
    events.emit('disconnect')
    expect(escalate).not.toHaveBeenCalled()
    const early = retirement({ deadlineMs: WORKER_SHUTDOWN_MS })
    early.events.emit('SIGTERM')
    await vi.advanceTimersByTimeAsync(DUPLICATE_SIGNAL_MS)
    early.events.emit('SIGTERM')
    expect(early.exit.mock.calls).toEqual([[0]])
    expect(exit).not.toHaveBeenCalled()
  })

  it('runs the shared close once for signals plus supervisor loss, then exits 0', async () => {
    const { events, exit, log, r } = retirement()
    const close = vi.fn(() => Promise.resolve())
    r.attach(close)
    for (const event of ['SIGTERM', 'disconnect', 'SIGINT', 'SIGHUP', 'SIGTERM']) events.emit(event)
    await vi.advanceTimersByTimeAsync(0)
    expect(close).toHaveBeenCalledTimes(1)
    expect(exit.mock.calls).toEqual([[0]])
    expect(log).toEqual(['[webui] SIGTERM received; shutting down'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('exits at the deadline when the close stalls', async () => {
    const { events, exit, log, r } = retirement()
    const close = vi.fn(() => new Promise<void>(() => undefined))
    r.attach(close)
    events.emit('disconnect')
    expect(r.retiring).toBe(true)
    await vi.advanceTimersByTimeAsync(999)
    expect(close).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit.mock.calls).toEqual([[1]])
    expect(log).toEqual(['[webui] supervisor disconnected; shutting down', '[webui] shutdown did not finish within 1000 ms; exiting'])
  })

  it('logs a rejected close and exits non-zero', async () => {
    const { events, exit, log, r } = retirement()
    r.attach(() => Promise.reject(new Error('synthetic flush failure')))
    events.emit('SIGHUP')
    await vi.advanceTimersByTimeAsync(0)
    expect(exit.mock.calls).toEqual([[1]])
    expect(log).toContain('[webui] shutdown failed: synthetic flush failure')
  })

  it('exits at once when retired during startup, before a close path exists', async () => {
    const { events, exit, r } = retirement()
    events.emit('disconnect')
    expect(exit.mock.calls).toEqual([[0]])
    const close = vi.fn(() => Promise.resolve())
    r.attach(close)
    await vi.advanceTimersByTimeAsync(5000)
    expect(close).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('retires at once when the supervisor was already gone before registration', () => {
    const { exit, log } = retirement({ connected: false })
    expect(exit.mock.calls).toEqual([[0]])
    expect(log).toEqual(['[webui] supervisor disconnected; shutting down'])
  })

  it('ignores IPC loss when not supervised', async () => {
    const { events, exit, r } = retirement({ supervised: false, connected: false })
    r.attach(() => Promise.resolve())
    events.emit('disconnect')
    await vi.advanceTimersByTimeAsync(5000)
    expect(exit).not.toHaveBeenCalled()
  })
})
