import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentCandidates, discoverAgentDir, discoverAgentDirForLaunch, discoverAgentPython } from './discover.js'
import { runBootstrap } from '../cli/launcher.js'

const scratches: string[] = []
afterEach(() => { for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function scratch(): string {
  const dir = join(tmpdir(), `talaria-discover-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  scratches.push(dir)
  return realpathSync(dir)
}

function pmInstall(rootName = 'state') {
  const home = scratch()
  const agent = join(home, 'custom-agent')
  mkdirSync(agent)
  const hermesHome = join(home, rootName)
  const key = createHash('sha256').update(realpathSync(agent)).digest('hex').slice(0, 16)
  const install = join(hermesHome, 'installs', key)
  const generation = join(install, 'environments', 'generation-one', 'venv')
  mkdirSync(join(generation, 'bin'), { recursive: true })
  writeFileSync(join(generation, 'pyvenv.cfg'), 'home = /synthetic/python\n')
  const python = join(generation, 'bin', 'python')
  writeFileSync(python, '')
  const record = (environment: unknown) => { writeFileSync(join(install, 'facts.json'), JSON.stringify({ packages: { venv: { environment } } })) }
  record(generation)
  return { agent, home, hermesHome, install, generation, python, record, env: { HOME: home, HERMES_HOME: hermesHome } }
}

describe('Agent discovery', () => {
  it('walks the documented candidate order and requires an Agent marker', () => {
    const home = scratch()
    const hermesHome = join(home, '.hermes')
    const webRoot = join(home, 'repo', 'web')
    mkdirSync(join(hermesHome, 'hermes-agent'), { recursive: true })
    mkdirSync(webRoot, { recursive: true })
    const opts = { env: {}, hermesHome, webRoot, home }
    expect(agentCandidates(opts).slice(0, 4)).toEqual([join(hermesHome, 'hermes-agent'), join(home, 'repo', 'hermes-agent'), join(home, 'hermes-agent'), '/opt/hermes'])
    // An empty directory is not a checkout.
    expect(discoverAgentDir(opts)).toBeNull()
    writeFileSync(join(hermesHome, 'hermes-agent', 'run_agent.py'), '')
    expect(discoverAgentDir(opts)).toBe(join(hermesHome, 'hermes-agent'))
    // The sibling checkout wins only when the explicit and home candidates are absent.
    mkdirSync(join(home, 'repo', 'hermes-agent', 'hermes_cli'), { recursive: true })
    expect(discoverAgentDir({ ...opts, hermesHome: join(home, 'elsewhere') })).toBe(join(home, 'repo', 'hermes-agent'))
    expect(discoverAgentDir({ ...opts, env: { HERMES_WEBUI_AGENT_DIR: join(home, 'repo', 'hermes-agent') } })).toBe(join(home, 'repo', 'hermes-agent'))
  })

  it('prefers HERMES_WEBUI_PYTHON, then the Agent venv interpreter', () => {
    const agent = scratch()
    const env = { HOME: agent, HERMES_HOME: join(agent, 'state') }
    expect(discoverAgentPython(env, agent)).toBeNull()
    mkdirSync(join(agent, '.venv', 'bin'), { recursive: true })
    writeFileSync(join(agent, '.venv', 'bin', 'python'), '')
    expect(discoverAgentPython(env, agent)).toBe(join(agent, '.venv', 'bin', 'python'))
    mkdirSync(join(agent, 'venv', 'bin'), { recursive: true })
    writeFileSync(join(agent, 'venv', 'bin', 'python'), '')
    expect(discoverAgentPython(env, agent)).toBe(join(agent, 'venv', 'bin', 'python'))
    expect(discoverAgentPython({ HERMES_WEBUI_PYTHON: '/usr/bin/python3' }, agent)).toBe('/usr/bin/python3')
    expect(discoverAgentPython({}, null)).toBeNull()
  })

  it('finds the committed PM generation before a legacy venv, using the real checkout path', () => {
    const f = pmInstall()
    const alias = join(f.home, 'agent-alias')
    symlinkSync(f.agent, alias)
    expect(discoverAgentPython(f.env, alias)).toBe(f.python)
    mkdirSync(join(f.agent, 'venv', 'bin'), { recursive: true })
    writeFileSync(join(f.agent, 'venv', 'bin', 'python'), '')
    expect(discoverAgentPython(f.env, f.agent)).toBe(f.python)
    expect(discoverAgentPython({ ...f.env, HERMES_WEBUI_PYTHON: '/chosen/python' }, f.agent)).toBe('/chosen/python')
  })

  it.each(['outside', 'prefix-sibling', 'symlink', 'missing-config', 'missing-python', 'malformed', 'wrong-type'])(
    'rejects a %s PM selection without falling back to stale dependencies', (kind) => {
      const f = pmInstall()
      mkdirSync(join(f.agent, 'venv', 'bin'), { recursive: true })
      writeFileSync(join(f.agent, 'venv', 'bin', 'python'), '')
      if (kind === 'outside' || kind === 'prefix-sibling' || kind === 'symlink') {
        const outside = kind === 'prefix-sibling' ? join(f.install, 'environments-other', 'venv') : join(f.home, 'other-venv')
        mkdirSync(join(outside, 'bin'), { recursive: true })
        writeFileSync(join(outside, 'pyvenv.cfg'), '')
        writeFileSync(join(outside, 'bin', 'python'), '')
        const linked = join(f.install, 'environments', 'linked')
        if (kind === 'symlink') symlinkSync(outside, linked)
        f.record(kind === 'symlink' ? linked : outside)
      } else if (kind === 'missing-config') rmSync(join(f.generation, 'pyvenv.cfg'))
      else if (kind === 'missing-python') rmSync(f.python)
      else if (kind === 'malformed') writeFileSync(join(f.install, 'facts.json'), '{')
      else f.record(42)
      expect(discoverAgentPython(f.env, f.agent)).toBeNull()
    },
  )

  it('keeps legacy discovery when no PM environment has been committed', () => {
    const f = pmInstall()
    f.record(null)
    mkdirSync(join(f.agent, '.venv', 'bin'), { recursive: true })
    const python = join(f.agent, '.venv', 'bin', 'python')
    writeFileSync(python, '')
    expect(discoverAgentPython(f.env, f.agent)).toBe(python)
    rmSync(join(f.install, 'facts.json'))
    expect(discoverAgentPython(f.env, f.agent)).toBe(python)
  })

  it('uses the shared PM root for a custom named profile', () => {
    const f = pmInstall()
    expect(discoverAgentPython({ ...f.env, HERMES_HOME: join(f.hermesHome, 'profiles', 'work') }, f.agent)).toBe(f.python)
  })

  it('uses the default root or an explicitly resolved launch home', () => {
    const f = pmInstall('.hermes')
    expect(discoverAgentPython({ HOME: f.home }, f.agent)).toBe(f.python)
    expect(discoverAgentPython({ HOME: f.home, HERMES_HOME: '~/.hermes/profiles/work' }, f.agent)).toBe(f.python)
    const custom = pmInstall()
    expect(discoverAgentPython({ HOME: custom.home }, custom.agent, custom.hermesHome)).toBe(custom.python)
  })

  it.each([null, [], { packages: [] }, { packages: null }, { packages: { venv: false } }])('rejects an invalid record shape: %j', (record) => {
    const f = pmInstall()
    writeFileSync(join(f.install, 'facts.json'), JSON.stringify(record))
    mkdirSync(join(f.agent, 'venv', 'bin'), { recursive: true })
    writeFileSync(join(f.agent, 'venv', 'bin', 'python'), '')
    expect(discoverAgentPython(f.env, f.agent)).toBeNull()
  })

  it('finds a custom install through the unquoted exec launcher', () => {
    const f = pmInstall()
    writeFileSync(join(f.agent, 'run_agent.py'), '')
    const bin = join(f.home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'hermes'), `#!/bin/sh\nexec ${join(f.agent, '.hermes', 'bin', 'hermes')} "$@"\n`)
    const agent = discoverAgentDirForLaunch({ env: { ...f.env, PATH: bin }, hermesHome: f.hermesHome, home: f.home, webRoot: join(f.home, 'web') })
    expect(agent).toBe(f.agent)
    expect(discoverAgentPython(f.env, agent)).toBe(f.python)
  })

  it.each([false, true])('worker discovery follows a new PM generation unless the interpreter is explicitly pinned: %s', async (explicit) => {
    const f = pmInstall()
    writeFileSync(join(f.agent, 'run_agent.py'), '')
    // This interpreter stands in for a successful import preflight, without loading a real Agent.
    writeFileSync(f.python, '#!/bin/sh\nexit 0\n')
    chmodSync(f.python, 0o755)
    const override = join(f.home, 'operator-python')
    writeFileSync(override, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const env: Record<string, string | undefined> = { ...f.env, HERMES_WEBUI_AGENT_DIR: f.agent }
    if (explicit) env.HERMES_WEBUI_PYTHON = override
    const next = join(f.install, 'environments', 'generation-two', 'venv')
    mkdirSync(join(next, 'bin'), { recursive: true })
    writeFileSync(join(next, 'pyvenv.cfg'), '')
    const nextPython = join(next, 'bin', 'python')
    writeFileSync(nextPython, '')
    const selected: (string | null)[] = []
    const code = await runBootstrap({
      env, hermesHome: f.hermesHome, home: f.home, webRoot: join(f.home, 'web'),
      compatibleAgentRevision: 'synthetic', serveCommand: [], log: () => undefined,
    }, { port: 8787, host: '127.0.0.1', noBrowser: true, skipAgentInstall: true, foreground: true }, () => {
      // A supervisor passes the same bootstrap environment to each newly started worker.
      selected.push(discoverAgentPython({ ...env }, f.agent, f.hermesHome))
      f.record(next)
      rmSync(f.generation, { recursive: true })
      selected.push(discoverAgentPython({ ...env }, f.agent, f.hermesHome))
      return Promise.resolve()
    })
    expect(code).toBe(0)
    expect(selected).toEqual(explicit ? [override, override] : [f.python, nextPython])
  })
})

describe('scripted sidecar command', () => {
  it('parses a JSON array or a whitespace command and rejects malformed values', async () => {
    const { scriptedSidecarCommand } = await import('./discover.js')
    expect(scriptedSidecarCommand({})).toBeNull()
    expect(scriptedSidecarCommand({ HERMES_WEBUI_SIDECAR_COMMAND: ' ' })).toBeNull()
    expect(scriptedSidecarCommand({ HERMES_WEBUI_SIDECAR_COMMAND: '["python3", "/x y/replay.py"]' })).toEqual(['python3', '/x y/replay.py'])
    expect(scriptedSidecarCommand({ HERMES_WEBUI_SIDECAR_COMMAND: 'python3 replay.py --flag' })).toEqual(['python3', 'replay.py', '--flag'])
    expect(() => scriptedSidecarCommand({ HERMES_WEBUI_SIDECAR_COMMAND: '[1]' })).toThrow('JSON array')
  })
})
