import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentCandidates, discoverAgentDir, discoverAgentPython } from './discover.js'

function scratch(): string {
  const dir = join(tmpdir(), `talaria-discover-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
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
    expect(discoverAgentPython({}, agent)).toBeNull()
    mkdirSync(join(agent, '.venv', 'bin'), { recursive: true })
    writeFileSync(join(agent, '.venv', 'bin', 'python'), '')
    expect(discoverAgentPython({}, agent)).toBe(join(agent, '.venv', 'bin', 'python'))
    mkdirSync(join(agent, 'venv', 'bin'), { recursive: true })
    writeFileSync(join(agent, 'venv', 'bin', 'python'), '')
    expect(discoverAgentPython({}, agent)).toBe(join(agent, 'venv', 'bin', 'python'))
    expect(discoverAgentPython({ HERMES_WEBUI_PYTHON: '/usr/bin/python3' }, agent)).toBe('/usr/bin/python3')
    expect(discoverAgentPython({}, null)).toBeNull()
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
