import { StartupTiming } from '../startup-timing.js'
import type { ChildProcess } from 'node:child_process'
import { delimiter } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('SidecarClient version mismatch', () => {
  let client: SidecarClient | null = null
  afterEach(async () => { await client?.close(); client = null })

  it('a decoded RPC version mismatch parks the client as incompatible instead of restarting forever', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-ver-'))
    // Answers every handshake with the mismatch error the real sidecar sends, then exits 3 like it does.
    const script = `require('readline').createInterface({input:process.stdin}).on('line',(line)=>{const req=JSON.parse(line);if(req.method==='runtime.handshake'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32000,message:'sidecar RPC version mismatch',data:{condition:'sidecar_rpc_version_mismatch'}}})+'\\n',()=>process.exit(3))}})`
    const logs: string[] = []
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script], agentDir: '', sidecarDir: dir, hermesHome: dir, log: (l) => logs.push(l), backoffMs: [20], handshakeTimeoutMs: 2_000 })
    await expect(client.start()).rejects.toMatchObject({ condition: 'sidecar_rpc_version_mismatch' })
    expect(client.status).toBe('incompatible')
    await new Promise((r) => setTimeout(r, 300))
    expect(client.status).toBe('incompatible')
    expect(logs.filter((l) => l.includes('restarting'))).toEqual([])
    expect(logs.filter((l) => l.includes('exited')).length).toBeLessThanOrEqual(1)
  })

  it('refuses a successful handshake that advertises the wrong RPC version', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-wrong-version-'))
    const fixture = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')
    const script = `const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))['runtime.handshake'][0].result;require('readline').createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);if(req.method==='runtime.handshake')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{...value,rpc_version:value.rpc_version+1}})+'\\n')})`
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, fixture], agentDir: '', sidecarDir: dir, hermesHome: dir, log: () => undefined })
    await expect(client.start()).rejects.toMatchObject({ condition: 'sidecar_rpc_version_mismatch' })
    expect(client.status).toBe('incompatible')
    await expect(client.call('config.get', { profile_home: dir, config_path: resolve(dir, 'config.yaml') })).rejects.toMatchObject({ condition: 'agent_incompatible' })
  })

  it('refuses config reads during startup when the live protocol version does not match', async () => {
    const fixture = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')
    const logs: string[] = []
    const script = `const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))['runtime.handshake'][0].result;require('readline').createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);process.stderr.write('seen '+req.method+'\\n');if(req.method==='runtime.status')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{...value,rpc_version:value.rpc_version+1}})+'\\n')})`
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, fixture], agentDir: '', sidecarDir, hermesHome: '', log: (line) => logs.push(line) })
    const starting = client.start().catch(() => undefined)
    await expect(client.call('config.get', { profile_home: '/synthetic', config_path: '/synthetic/config.yaml' })).rejects.toMatchObject({ condition: 'sidecar_rpc_version_mismatch' })
    expect(client.status).toBe('starting')
    expect(logs.filter((line) => line.includes('seen config.get'))).toEqual([])
    await client.close()
    await starting
  })

  it('recovers config access when an import-failed sidecar exits', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-config-restart-'))
    const fixture = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')
    const starts = resolve(dir, 'starts')
    const script = `const fs=require('fs');const [fixture,starts]=process.argv.slice(1);const value=JSON.parse(fs.readFileSync(fixture,'utf8'))['runtime.handshake'][0].result;fs.appendFileSync(starts,'x');require('readline').createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);if(req.method==='runtime.handshake')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{...value,compatible:false,import_error:'synthetic Agent import failure'}})+'\\n');if(req.method==='config.get')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{path:req.params.config_path,exists:false,config:{}}})+'\\n',()=>process.exit(1))})`
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, fixture, starts], agentDir: '', sidecarDir: dir, hermesHome: dir, log: () => undefined, backoffMs: [20] })
    await client.start()
    const config_path = resolve(dir, 'config.yaml')
    expect((await client.call('config.get', { profile_home: dir, config_path })).config).toEqual({})
    const deadline = Date.now() + 5000
    while ((client.status !== 'incompatible' || !existsSync(starts) || readFileSync(starts, 'utf8').length < 2) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(readFileSync(starts, 'utf8')).toBe('xx')
    expect(client.status).toBe('incompatible')
    expect((await client.call('config.get', { profile_home: dir, config_path })).config).toEqual({})
  })

  it('an already-aborted signal is refused before anything is written to the sidecar', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-abort-'))
    const fixture = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')
    // Answers the handshake from the fixture and echoes every request method on stderr so the test can prove nothing was sent.
    const script = `const fs=require('fs');const fixture=process.argv[1];require('readline').createInterface({input:process.stdin}).on('line',(line)=>{const req=JSON.parse(line);process.stderr.write('seen '+req.method+'\\n');if(req.method==='runtime.handshake'){const result=JSON.parse(fs.readFileSync(fixture,'utf8'))['runtime.handshake'][0].result;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n')}})`
    const logs: string[] = []
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, fixture], agentDir: '', sidecarDir: dir, hermesHome: dir, log: (l) => logs.push(l), backoffMs: [20], handshakeTimeoutMs: 5_000 })
    await client.start()
    const controller = new AbortController()
    controller.abort()
    await expect(client.call('runtime.ensure_current', {}, { signal: controller.signal })).rejects.toMatchObject({ condition: 'cancelled' })
    await new Promise((r) => setTimeout(r, 100))
    expect(logs.filter((l) => l.includes('seen runtime.ensure_current'))).toEqual([])
  })

  it('a delayed runtime status cannot replace a newer readiness verdict', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-status-'))
    const fixture = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')
    const script = `const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))['runtime.handshake'][0].result;let count=0;require('readline').createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');if(req.method==='runtime.handshake')send(value);if(req.method==='runtime.status'){if(++count===1)setTimeout(()=>send(value),80);else send({...value,stale:true,agent_source_changed:true})}})`
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, fixture], agentDir: '', sidecarDir: dir, hermesHome: dir, log: () => undefined })
    await client.start()
    const earlier = client.call('runtime.status', {})
    await client.call('runtime.status', {})
    expect(client.status).toBe('incompatible')
    await earlier
    expect(client.status).toBe('incompatible')
    expect(client.describe?.stale).toBe(true)
  })

  it('notifies validated reconnects once and releases its handshake subscription', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-handshake-listener-'))
    const fixture = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')
    const starts = resolve(dir, 'starts')
    const script = `const fs=require('fs');const [fixture,starts]=process.argv.slice(1);fs.appendFileSync(starts,'x');const value=JSON.parse(fs.readFileSync(fixture,'utf8'))['runtime.handshake'][0].result;require('readline').createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);if(req.method==='runtime.handshake')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:value})+'\\n')})`
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, fixture, starts], agentDir: '', sidecarDir: dir, hermesHome: dir, log: () => undefined, backoffMs: [10] })
    const listener = vi.fn()
    const unsubscribe = client.onHandshake(listener)
    await client.start()
    expect(listener).toHaveBeenCalledTimes(1)
    client.recycle('synthetic reconnect')
    await vi.waitFor(() => { expect(listener).toHaveBeenCalledTimes(2) })
    unsubscribe()
    client.recycle('synthetic reconnect after unsubscribe')
    await vi.waitFor(() => { expect(readFileSync(starts, 'utf8')).toBe('xxx'); expect(client?.status).toBe('ready') })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('runs every ready gate after a compatible handshake and before readiness, and a failing gate does not block it', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-ready-gate-'))
    const fixture = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')
    const script = `const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))['runtime.handshake'][0].result;require('readline').createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');if(req.method==='runtime.handshake')send(value);if(req.method==='worktree.retain')send({results:Object.fromEntries(req.params.paths.map(p=>[p,'retained']))})})`
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, fixture], agentDir: '', sidecarDir: dir, hermesHome: dir, log: () => undefined, backoffMs: [10] })
    const seen: string[] = []
    await client.addReadyGate(() => Promise.reject(new Error('synthetic gate failure')))
    await client.addReadyGate(async (call) => { seen.push(`${client!.status} ${JSON.stringify((await call('worktree.retain', { paths: ['/wt'] })).results)}`) })
    await client.start()
    expect(seen).toEqual(['starting {"/wt":"retained"}'])
    expect(client.status).toBe('ready')
    client.recycle('synthetic restart')
    await vi.waitFor(() => { expect(seen).toHaveLength(2); expect(client?.status).toBe('ready') })
    expect(seen[1]).toBe('starting {"/wt":"retained"}')
    await client.addReadyGate(async (call) => { seen.push(`${client!.status} ${JSON.stringify((await call('worktree.retain', { paths: [] })).results)}`) })
    expect(seen[2]).toBe('ready {}')
  })

  it('runs the ready gates before a runtime recovered in place turns ready through runtime.status', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-ready-gate-recovery-'))
    const fixture = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')
    const script = `const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))['runtime.handshake'][0].result;require('readline').createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');if(req.method==='runtime.handshake')send({...value,stale:true,agent_source_changed:true});if(req.method==='runtime.status')send(value);if(req.method==='worktree.retain')send({results:{}})})`
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, fixture], agentDir: '', sidecarDir: dir, hermesHome: dir, log: () => undefined })
    const seen: string[] = []
    await client.start()
    await client.addReadyGate(async (call) => { await call('worktree.retain', { paths: [] }); seen.push(client!.status) })
    expect(client.status).toBe('incompatible')
    expect(seen).toEqual([])
    await client.call('runtime.status', {})
    expect(seen).toEqual(['incompatible'])
    expect(client.status).toBe('ready')
    await client.call('runtime.status', {})
    expect(seen).toHaveLength(1)
  })

  it('a closed client cannot publish a late handshake or notify recovery', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-closed-handshake-'))
    const fixture = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')
    const script = `const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))['runtime.handshake'][0].result;require('readline').createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);if(req.method==='runtime.handshake')setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:value})+'\\n'),80)})`
    client = new SidecarClient({ python: process.execPath, command: [process.execPath, '-e', script, fixture], agentDir: '', sidecarDir: dir, hermesHome: dir, log: () => undefined })
    const listener = vi.fn()
    client.onHandshake(listener)
    const pending = expect(client.start()).rejects.toMatchObject({ condition: 'sidecar_unavailable' })
    await client.close()
    await pending
    expect(client.status).toBe('stopped')
    expect(client.describe).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it('a spawn failure schedules the same backoff restart as a crash instead of parking the client', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'talaria-sidecar-spawn-'))
    const logs: string[] = []
    client = new SidecarClient({ python: resolve(dir, 'missing-interpreter'), agentDir: '', sidecarDir: dir, hermesHome: dir, log: (l) => logs.push(l), backoffMs: [20], handshakeTimeoutMs: 2_000 })
    await expect(client.start()).rejects.toMatchObject({ condition: 'sidecar_unavailable' })
    expect(client.status).toBe('restarting')
    await new Promise((r) => setTimeout(r, 150))
    // Each attempt fails the same way and re-arms the timer; exactly one restart is scheduled per failure.
    expect(logs.filter((l) => l.includes('spawn error')).length).toBeGreaterThanOrEqual(2)
    expect(client.status).toBe('restarting')
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

  it('binds the repair-intent directory before changing the sidecar working directory', () => {
    const base = { hermesHome: '/synthetic/hermes', agentDir: '/agent', sidecarDir: '/sidecar' }
    expect(sidecarSpawnEnv({ ...base, env: { HERMES_WEBUI_STATE_DIR: 'relative-web-state' } }).TALARIA_SIDECAR_WEB_STATE_DIR).toBe(resolve('relative-web-state'))
    expect(sidecarSpawnEnv({ ...base, env: { HOME: '/synthetic', HERMES_WEBUI_STATE_DIR: '~/web-state' } }).TALARIA_SIDECAR_WEB_STATE_DIR).toBe(resolve('/synthetic/web-state'))
    expect(sidecarSpawnEnv(base).TALARIA_SIDECAR_WEB_STATE_DIR).toBe(resolve('/synthetic/hermes/webui'))
  })

  it('keeps Web operator secrets out of the sidecar environment', () => {
    const env = sidecarSpawnEnv({
      env: {
        HERMES_WEBUI_PASSWORD: 'synthetic-pw', HERMES_WEBUI_OIDC_CLIENT_SECRET: 'synthetic-oidc', HERMES_WEBUI_PASSKEY: 'synthetic-passkey',
        HERMES_WEBUI_GATEWAY_API_KEY: 'synthetic-gateway', TALARIA_RELEASE_TOKEN: 'synthetic-release',
        HERMES_WEBUI_AGENT_DIR: '/agent', HERMES_WEBUI_PYTHON: '/venv/bin/python', TALARIA_SIDECAR_LOG_LEVEL: 'debug',
        OPENAI_API_KEY: 'sk-synthetic', HTTPS_PROXY: 'http://proxy:3128',
      },
      hermesHome: '/h', agentDir: '/a', sidecarDir: '/s',
    })
    for (const key of ['HERMES_WEBUI_PASSWORD', 'HERMES_WEBUI_OIDC_CLIENT_SECRET', 'HERMES_WEBUI_PASSKEY', 'HERMES_WEBUI_GATEWAY_API_KEY', 'TALARIA_RELEASE_TOKEN']) {
      expect(env).not.toHaveProperty(key)
    }
    expect(env).toMatchObject({ HERMES_WEBUI_AGENT_DIR: '/agent', HERMES_WEBUI_PYTHON: '/venv/bin/python', TALARIA_SIDECAR_LOG_LEVEL: 'debug', OPENAI_API_KEY: 'sk-synthetic', HTTPS_PROXY: 'http://proxy:3128' })
  })

  it('disables Agent lazy installs even when the configured environment enables them', () => {
    expect(sidecarSpawnEnv({ env: { HERMES_DISABLE_LAZY_INSTALLS: '0' }, hermesHome: '/h', agentDir: '/a', sidecarDir: '/s' }).HERMES_DISABLE_LAZY_INSTALLS).toBe('1')
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
    await expect.poll(() => client?.status, { timeout: 5_000 }).toBe('incompatible')
    await expect(client.call('rpc.methods', {})).rejects.toBeInstanceOf(SidecarError)
  })
})


describe('startup timing at the RPC transport boundary', () => {
  const transport = () => {
    const client = new SidecarClient({ python: '', sidecarDir: '', agentDir: '', hermesHome: '', log: () => undefined })
    const requests: { id: number; trace_id?: string; method: string }[] = []
    const child = { stdin: { writable: true, write: (line: string, callback?: (error?: Error) => void) => { requests.push(JSON.parse(line) as { id: number; trace_id?: string; method: string }); callback?.() } } } as unknown as ChildProcess
    const internal = client as unknown as { child: ChildProcess; closed: boolean; onLine: (line: string) => void; onExit: (child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) => void }
    internal.child = child
    client.status = 'ready'
    return { client, internal, child, requests }
  }
  afterEach(() => { vi.useRealTimers() })

  it.each(['before_dispatch', 'timeout', 'exit'] as const)('records %s without changing cancellation or pending-call semantics', async (scenario) => {
    vi.useFakeTimers()
    const { client, internal, child, requests } = transport()
    const logs: string[] = []
    const timing = new StartupTiming((line) => logs.push(line))
    const controller = new AbortController()
    if (scenario === 'before_dispatch') controller.abort()
    const result = client.call('runtime.ensure_current', {}, { timing, signal: controller.signal, timeoutMs: 25 })
    const condition = scenario === 'before_dispatch' ? 'cancelled' : scenario === 'timeout' ? 'sidecar_timeout' : 'sidecar_unavailable'
    const rejected = expect(result).rejects.toMatchObject({ condition })
    if (scenario === 'timeout') await vi.advanceTimersByTimeAsync(25)
    if (scenario === 'exit') { internal.closed = true; internal.onExit(child, 1, null) }
    await rejected
    timing.finish()
    const record = JSON.parse(logs[0]!.slice(logs[0]!.indexOf('{'))) as { outcome: string; spans: Record<string, { outcome: string }> }
    expect(record.outcome).toBe(scenario === 'before_dispatch' ? 'cancelled' : scenario === 'timeout' ? 'timeout' : 'unknown')
    expect(record.spans.sidecar_call?.outcome).toBe(record.outcome)
    if (scenario === 'before_dispatch') expect(requests).toHaveLength(0)
    if (scenario === 'timeout') expect(requests.map((r) => r.method)).toEqual(['runtime.ensure_current', 'rpc.cancel'])
  })

  it('binds interleaved pending calls to their own trace and first output', async () => {
    const { client, internal, requests } = transport()
    const first = new StartupTiming(() => undefined)
    const second = new StartupTiming(() => undefined)
    const calls = [client.call('runtime.ensure_current', {}, { timing: first }), client.call('runtime.ensure_current', {}, { timing: second })]
    expect(requests.map((r) => r.trace_id)).toEqual([first.traceId, second.traceId])
    internal.onLine(JSON.stringify({ jsonrpc: '2.0', method: 'stream', params: { id: requests[1]!.id, seq: 1, event: 'token', data: { text: 'SECRET' } } }))
    expect(first.snapshot().observations.first_sidecar_output).toBeUndefined()
    expect(second.snapshot().observations.first_sidecar_output).toBeTypeOf('number')
    for (const request of [...requests].reverse()) internal.onLine(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { current: true, agent_revision: null } }))
    await Promise.all(calls)
    expect(first.rpcId).toBe(requests[0]!.id)
    expect(second.rpcId).toBe(requests[1]!.id)
  })
})
