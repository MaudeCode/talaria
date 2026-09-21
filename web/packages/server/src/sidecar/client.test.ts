import { delimiter } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { SIDECAR_RPC_VERSION } from '@maudecode/talaria-web-contracts'
import { SidecarClient, SidecarError, sidecarSpawnEnv } from './client.js'
import { FakeSidecar } from './fake.js'

const agentDir = process.env.HERMES_WEBUI_AGENT_DIR ?? resolve(homedir(), '.hermes/hermes-agent')
const python = process.env.HERMES_WEBUI_PYTHON ?? resolve(agentDir, 'venv/bin/python')
const sidecarDir = resolve(import.meta.dirname, '../../../../sidecar')
const agentAvailable = existsSync(resolve(agentDir, 'run_agent.py')) && existsSync(python)

describe('SidecarClient handshake recovery', () => {
  let client: SidecarClient | null = null
  afterEach(async () => { await client?.close(); client = null })

  it('kills and restarts a child whose handshake hangs instead of parking it as incompatible', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-hs-'))
    const marker = resolve(dir, 'answer')
    const fixture = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')
    // Answers the handshake only once the marker exists; before that it swallows every request.
    const script = `const fs=require('fs');const [marker,fixture]=process.argv.slice(1);require('readline').createInterface({input:process.stdin}).on('line',(line)=>{const req=JSON.parse(line);if(req.method==='runtime.handshake'&&fs.existsSync(marker)){const result=JSON.parse(fs.readFileSync(fixture,'utf8'))['runtime.handshake'][0].result;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n')}})`
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, marker, fixture], agentDir: '', sidecarDir: dir, hermesHome: dir, log: () => undefined, backoffMs: [50], handshakeTimeoutMs: 200 })
    await expect(client.start()).rejects.toMatchObject({ condition: 'sidecar_timeout' })
    expect(client.status).toBe('restarting')
    await expect(client.call('rpc.methods', {})).rejects.toMatchObject({ condition: 'sidecar_unavailable' })
    writeFileSync(marker, '')
    const deadline = Date.now() + 5000
    while (client.status !== 'ready' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(client.status).toBe('ready')
  })
})

describe('FakeSidecar', () => {
  it('answers from fixtures and validates shapes', async () => {
    const fake = new FakeSidecar()
    const describe = await fake.call('runtime.handshake', { rpc_version: SIDECAR_RPC_VERSION })
    expect(describe.rpc_version).toBe(SIDECAR_RPC_VERSION)
    expect(fake.calls).toEqual([{ method: 'runtime.handshake', params: { rpc_version: SIDECAR_RPC_VERSION } }])
  })

  it('rejects a responder result that violates the contract', async () => {
    const fake = new FakeSidecar()
    fake.respond('runtime.ensure_current', () => ({ current: true, agent_revision: 42 as unknown as string }))
    await expect(fake.call('runtime.ensure_current', {})).rejects.toThrow()
  })

  it('forwards the configured environment to the sidecar while keeping its identity keys', () => {
    const env = sidecarSpawnEnv({ env: { HERMES_API_KEY: 'k', HTTPS_PROXY: 'http://proxy:3128', PYTHONPATH: '/extra', HERMES_HOME: '/spoofed' }, hermesHome: '/home/u/.hermes', agentDir: '/agent', sidecarDir: '/web/sidecar' })
    expect(env).toMatchObject({ HERMES_API_KEY: 'k', HTTPS_PROXY: 'http://proxy:3128', HERMES_HOME: '/home/u/.hermes', TALARIA_SIDECAR_AGENT_DIR: '/agent', PYTHONPATH: `/web/sidecar${delimiter}/extra`, PYTHONUNBUFFERED: '1' })
    // A getter is read at spawn time, so a runtime `.env` edit reaches a restarted child instead of the launch snapshot.
    const live: Record<string, string> = { OPENAI_API_KEY: 'sk-old' }
    const opts = { env: () => ({ ...live }), hermesHome: '/h', agentDir: '/a', sidecarDir: '/s' }
    expect(sidecarSpawnEnv(opts).OPENAI_API_KEY).toBe('sk-old')
    delete live.OPENAI_API_KEY
    expect(sidecarSpawnEnv(opts)).not.toHaveProperty('OPENAI_API_KEY')
  })

  it('fails closed when not ready', async () => {
    const fake = new FakeSidecar({ status: 'restarting' })
    await expect(fake.call('rpc.methods', {})).rejects.toMatchObject({ condition: 'sidecar_unavailable' })
  })

  it('streams frames to the caller in order', async () => {
    const fake = new FakeSidecar()
    fake.respond('runtime.status', (_params, emit) => {
      emit({ event: 'progress', data: { step: 1 } })
      emit({ event: 'progress', data: { step: 2 } })
      return fake.describe!
    })
    const seen: number[] = []
    await fake.call('runtime.status', {}, { onStream: (frame) => { seen.push(frame.seq) } })
    expect(seen).toEqual([1, 2])
  })
})

describe.skipIf(!agentAvailable)('SidecarClient against the pinned Agent', () => {
  let client: SidecarClient | null = null
  afterEach(async () => { await client?.close(); client = null })

  it('handshakes, lists methods, and fails closed on unknown methods', async () => {
    const hermesHome = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-'))
    client = new SidecarClient({ python, agentDir, sidecarDir, hermesHome, log: () => undefined })
    const describe = await client.start()
    expect(describe.compatible).toBe(true)
    expect(client.status).toBe('ready')
    const methods = await client.call('rpc.methods', {})
    expect(methods.methods).toContain('runtime.handshake')
    await expect(client.call('runtime.shutdown', { exit_code: 'x' as unknown as number })).rejects.toThrow()
  })

  it('stops restarting after a version-mismatch exit', async () => {
    const hermesHome = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-'))
    client = new SidecarClient({ python, agentDir, sidecarDir, hermesHome, log: () => undefined, backoffMs: [10] })
    await client.start()
    await client.call('runtime.shutdown', { exit_code: 3 })
    await new Promise((r) => setTimeout(r, 300))
    expect(client.status).toBe('incompatible')
    await expect(client.call('rpc.methods', {})).rejects.toBeInstanceOf(SidecarError)
  })
})
