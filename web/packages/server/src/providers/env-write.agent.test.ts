import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SidecarClient } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

const agentDir = process.env.TALARIA_WEB_AGENT_DIR ?? resolve(homedir(), '.hermes/hermes-agent')
const python = process.env.TALARIA_WEB_PYTHON ?? [resolve(agentDir, 'venv/bin/python'), resolve(agentDir, '.venv/bin/python')].find((p) => existsSync(p)) ?? ''
const sidecarDir = resolve(import.meta.dirname, '../../../../sidecar')
const agentAvailable = existsSync(resolve(agentDir, 'run_agent.py')) && existsSync(python)
// Agents before v0.21.6 have no `.env` lock for a concurrent write to wait on.
const agentLocksEnv = agentAvailable && spawnSync(python, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from hermes_cli import config; print(hasattr(config, "_env_write_lock"))', agentDir], { encoding: 'utf8' }).stdout.trim() === 'True'

// The Agent's own `save_env_value`, paused between its locked read and its atomic replace until the test writes a line
// to its stdin (or the test exits and closes it).
const PAUSED_AGENT_WRITE = `
import sys
sys.path.insert(0, sys.argv[1])
from hermes_cli import config
ready = sys.argv[2]
original = config._write_env_lines
def paused(*args, **kwargs):
    open(ready, "w").close()
    sys.stdin.readline()
    return original(*args, **kwargs)
config._write_env_lines = paused
config.save_env_value("AGENT_WRITTEN_KEY", "from-agent")
`

// Loaded into the sidecar through PYTHONPATH: logs each exclusive flock attempt on `.env.lock`. A second attempt is a
// retry, which the Agent's lock helper makes only after the first attempt found the lock held.
const LOCK_ATTEMPT_LOG = (lock: string, log: string): string => `
import fcntl, os, sys
def _log_env_lock_attempts(event, args):
    if event != "fcntl.flock" or not args[1] & fcntl.LOCK_EX:
        return
    try:
        held, lock = os.fstat(args[0]), os.stat(${JSON.stringify(lock)})
    except OSError:
        return
    if (held.st_dev, held.st_ino) == (lock.st_dev, lock.st_ino):
        with open(${JSON.stringify(log)}, "a") as f:
            f.write("attempt\\n")
sys.addaudithook(_log_env_lock_attempts)
`

describe.skipIf(!agentLocksEnv)('provider key writes against the pinned Agent (TAL-797)', () => {
  let s: TestServer | null = null
  let client: SidecarClient | null = null
  afterEach(async () => { await s?.close(); await client?.close(); s = null; client = null })

  it('keeps a key saved while the Agent rewrites the same .env', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-env-write-'))
    writeFileSync(join(home, '.env'), 'EXISTING=1\n', { mode: 0o600 })
    const attempts = join(home, 'lock-attempts')
    const hooks = join(home, 'sidecar-hooks')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'sitecustomize.py'), LOCK_ATTEMPT_LOG(join(home, '.env.lock'), attempts))
    client = new SidecarClient({ python, agentDir, sidecarDir, hermesHome: home, env: { PYTHONPATH: hooks }, log: () => undefined })
    await client.start()
    s = await bootTestServer({ sidecar: client, env: { HERMES_HOME: home, TALARIA_WEB_STATE_DIR: home } })

    const ready = join(home, 'agent-ready')
    const agent = spawn(python, ['-c', PAUSED_AGENT_WRITE, agentDir, ready], { env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home }, stdio: ['pipe', 'ignore', 'pipe'] })
    let agentErr = ''
    agent.stderr.on('data', (chunk: Buffer) => { agentErr += chunk.toString() })
    const agentExit = new Promise<number | null>((done) => { agent.on('exit', done) })
    await expect.poll(() => existsSync(ready), { timeout: 15_000 }).toBe(true)

    // Talaria's save lands inside the window the Agent holds between reading the file and replacing it, and retries the lock.
    writeFileSync(attempts, '')
    const saved = s.get('/api/providers', { method: 'POST', body: JSON.stringify({ provider: 'deepseek', api_key: 'sk-deepseek-from-talaria' }), headers: { 'content-type': 'application/json' } })
    await expect.poll(() => readFileSync(attempts, 'utf8').split('\n').filter(Boolean).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    agent.stdin.end('go\n')
    const res = await saved
    expect(await agentExit, agentErr).toBe(0)

    expect(res.status).toBe(200)
    const lines = readFileSync(join(home, '.env'), 'utf8').split('\n').filter(Boolean)
    expect(lines).toEqual(expect.arrayContaining(['EXISTING=1', 'AGENT_WRITTEN_KEY=from-agent', 'DEEPSEEK_API_KEY=sk-deepseek-from-talaria']))
    expect(statSync(join(home, '.env')).mode & 0o777).toBe(0o600)
  }, 60_000)
})
