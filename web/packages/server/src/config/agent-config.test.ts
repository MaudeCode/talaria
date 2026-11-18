import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { AgentConfig, ConfigUnavailable } from './agent-config.js'

type Json = Record<string, unknown>

describe('config path override (review round 39)', () => {
  it('HERMES_CONFIG_PATH is the file the sidecar reads, writes, and the server fingerprints', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-cfg-'))
    const override = join(home, 'managed', 'override.yaml')
    mkdirSync(join(home, 'managed'))
    writeFileSync(override, 'webui_oidc:\n  issuer: https://idp.example\n')
    const sidecar = new FakeSidecar()
    const seen: string[] = []
    sidecar.respond('config.get', (params) => { seen.push(params.config_path); return { path: params.config_path, exists: true, config: { webui_oidc: { issuer: 'https://idp.example' } } } })
    sidecar.respond('config.set', (params) => { seen.push(params.config_path); writeFileSync(params.config_path, `# ${String(Math.random())}\n`); return { ok: true as const, path: params.config_path } })
    const config = new AgentConfig({ sidecar: () => sidecar, env: { HERMES_CONFIG_PATH: override } })
    expect(config.path(home)).toBe(override)
    // No <home>/config.yaml: without the override the read would short-circuit to {} and never reach the sidecar.
    expect(((await config.read(home)).webui_oidc as Json).issuer).toBe('https://idp.example')
    await config.update(home, (c) => { c.max_tokens = 1 })
    expect(seen).toEqual([override, override])
    expect(new AgentConfig({ sidecar: () => sidecar, env: { HERMES_CONFIG_PATH: '~/x.yaml' } }).path(home)).toBe(join(homedir(), 'x.yaml'))
    rmSync(home, { recursive: true, force: true })
  })
})

describe('config file readability and shared-override locking (review round 40)', () => {
  it.skipIf(process.getuid?.() === 0)('an unreadable config.yaml is unavailable, never an empty config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-cfg-'))
    const dir = join(home, 'locked')
    mkdirSync(dir)
    writeFileSync(join(dir, 'config.yaml'), 'webui_oidc:\n  issuer: https://idp.example\n')
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', () => { throw new Error('must not be reached') })
    const config = new AgentConfig({ sidecar: () => sidecar, env: {} })
    chmodSync(dir, 0o000)
    try {
      await expect(config.read(dir)).rejects.toThrow(ConfigUnavailable)
      expect(config.peek(dir)).toBeNull()
    } finally {
      chmodSync(dir, 0o700)
      rmSync(home, { recursive: true, force: true })
    }
    // A genuinely absent file is still the empty config.
    expect(await config.read(join(tmpdir(), 'talaria-absent-home'))).toEqual({})
  })

  it('updates from different homes that share an HERMES_CONFIG_PATH override serialise on the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'talaria-cfg-'))
    const override = join(root, 'shared.yaml')
    writeFileSync(override, '# 0\n')
    let stored: Json = {}
    let n = 0
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', (params) => ({ path: params.config_path, exists: true, config: structuredClone(stored) }))
    sidecar.respond('config.set', (params) => {
      stored = params.config
      n += 1
      const t = Date.now() / 1000 + n
      writeFileSync(override, `# ${String(n)}\n`)
      utimesSync(override, t, t)
      return { ok: true as const, path: params.config_path }
    })
    const config = new AgentConfig({ sidecar: () => sidecar, env: { HERMES_CONFIG_PATH: override } })
    await Promise.all([config.update(join(root, 'a'), (c) => { c.from_a = 1 }), config.update(join(root, 'b'), (c) => { c.from_b = 1 })])
    expect(stored).toEqual({ from_a: 1, from_b: 1 })
    config.invalidate(join(root, 'a'))
    expect(config.peek(join(root, 'b'))).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('config snapshot fingerprint (review round 15)', () => {
  it('a config.yaml replaced during the read is re-read, and reported unavailable if it keeps changing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-cfg-'))
    writeFileSync(join(home, 'config.yaml'), 'terminal:\n  backend: local\n')
    let calls = 0
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', (params) => {
      calls += 1
      // Simulate an atomic replacement landing while the RPC is in flight: first answer is the old contents.
      if (calls === 1) { const t = Date.now() / 1000 + 5; writeFileSync(join(home, 'config.yaml'), 'terminal:\n  backend: ssh\n'); utimesSync(join(home, 'config.yaml'), t, t); return { path: join(params.profile_home, 'config.yaml'), exists: true, config: { terminal: { backend: 'local' } } } }
      return { path: join(params.profile_home, 'config.yaml'), exists: true, config: { terminal: { backend: 'ssh' } } }
    })
    const config = new AgentConfig({ sidecar: () => sidecar, env: {} })
    const first = await config.read(home)
    expect(calls).toBe(2)
    expect((first.terminal as Json).backend).toBe('ssh')
    expect((config.peek(home)?.terminal as Json).backend).toBe('ssh')
    // A file that keeps changing under the reader is unavailable rather than cached under the wrong key.
    let n = 0
    sidecar.respond('config.get', (params) => { n += 1; const t = Date.now() / 1000 + 10 + n; writeFileSync(join(home, 'config.yaml'), `# ${String(n)}\n`); utimesSync(join(home, 'config.yaml'), t, t); return { path: join(params.profile_home, 'config.yaml'), exists: true, config: {} } })
    config.invalidate()
    await expect(config.read(home)).rejects.toThrow(/changed while it was being read/)
    expect(config.peek(home)).toBeNull()
    rmSync(home, { recursive: true, force: true })
  })
})
