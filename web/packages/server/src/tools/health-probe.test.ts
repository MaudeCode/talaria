/** TAL-1707: what the per-tab `ops.agent` poll and the gateway restart waits cost, and when they read the Gateway afresh. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer } from '../test/harness.js'
import { liveGateways } from './health.js'

const io = vi.hoisted(() => ({ spawns: 0, lstart: '', reads: [] as string[] }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = (file: string, ...rest: unknown[]) => {
    if (file !== 'ps') return (actual.execFile as unknown as (...args: unknown[]) => unknown)(file, ...rest)
    io.spawns += 1
    const callback = rest.at(-1) as (error: Error | null, stdout: string) => void
    setImmediate(() => { callback(null, io.lstart) })
    return undefined
  }
  return { ...actual, execFile }
})

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const readFileSync = (path: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) => {
    const name = String(path)
    // No /proc start ticks: Linux CI reaches `ps` as macOS does.
    if (/^\/proc\/\d+\/stat$/.test(name)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (/gateway(\.pid|_state\.json)$/.test(name)) io.reads.push(name.slice(name.lastIndexOf('/') + 1))
    return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
  }
  return { ...fs, readFileSync }
})

const STARTED_MS = 1_700_000_000_000
const OTHER_START_MS = STARTED_MS + 3_600_000
const startTime = (ms: number) => Math.round(ms / 10)
const reads = (file: string) => io.reads.filter((name) => name === file).length

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => { io.spawns = 0; io.reads = []; io.lstart = new Date(STARTED_MS).toString() })

/** The record the Agent writes for a gateway; `tag` changes its size the way a rewrite changes its signature. */
function writeRecord(dir: string, ms: number, tag = ''): void {
  writeFileSync(join(dir, 'gateway.pid'), JSON.stringify({ pid: process.pid, kind: 'hermes-gateway', start_time: startTime(ms), tag }))
  writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running', updated_at: new Date().toISOString() }))
}

describe('the ops.agent gateway probe (TAL-1707)', () => {
  it('answers 20 polls with one ps spawn and one read of each file in a window, and keeps the start time across windows', async () => {
    let clock = Date.now() / 1000
    const s = await bootTestServer({ sidecar: new FakeSidecar(), now: () => clock })
    try {
      writeRecord(s.state, STARTED_MS)
      const poll = async () => (await (await s.get('/api/health/agent')).json()) as { alive: unknown }
      const answers = await Promise.all(Array.from({ length: 10 }, poll))
      for (let i = 0; i < 10; i += 1) answers.push(await poll())
      expect(answers.map((answer) => answer.alive)).toEqual(Array.from({ length: 20 }, () => true))
      expect(io.spawns).toBe(1)
      expect([reads('gateway.pid'), reads('gateway_state.json')]).toEqual([1, 1])
      clock += 5
      expect((await poll()).alive).toBe(true)
      expect(io.spawns).toBe(1)
      expect([reads('gateway.pid'), reads('gateway_state.json')]).toEqual([2, 2])
    } finally { await s.close() }
  })
})

describe('the gateway restart waits (TAL-1707)', () => {
  const home = () => { const dir = mkdtempSync(join(tmpdir(), `talaria-${basename(import.meta.filename, '.ts')}-`)); dirs.push(dir); return dir }

  it('read the pid record every poll and spawn ps once, until a rewritten record re-probes', async () => {
    const dir = home()
    const now = Date.now() / 1000
    writeRecord(dir, STARTED_MS)
    expect(await liveGateways(dir, dir, now)).toEqual([{ dir, pid: process.pid, start_time: startTime(STARTED_MS) }])
    expect(await liveGateways(dir, dir, now)).toHaveLength(1)
    expect(io.spawns).toBe(1)
    expect(reads('gateway.pid')).toBe(2)
    // The gateway restarted under the same pid: a new record, a new process.
    io.lstart = new Date(OTHER_START_MS).toString()
    writeRecord(dir, OTHER_START_MS, 'restarted')
    expect(await liveGateways(dir, dir, now)).toEqual([{ dir, pid: process.pid, start_time: startTime(OTHER_START_MS) }])
    expect(io.spawns).toBe(2)
  })

  it('re-probe a pid they saw die or stopped watching, so a reused pid is not taken for the gateway', async () => {
    const dir = home()
    const now = Date.now() / 1000
    writeRecord(dir, STARTED_MS)
    expect(await liveGateways(dir, dir, now)).toHaveLength(1)
    expect(io.spawns).toBe(1)
    // The gateway dies under an unchanged record; another process then takes the pid.
    vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) })
    expect(await liveGateways(dir, dir, now + 1)).toEqual([])
    io.lstart = new Date(OTHER_START_MS).toString()
    expect(await liveGateways(dir, dir, now + 2)).toEqual([])
    expect(io.spawns).toBe(2)
    // No poll saw the change: a long gap between polls cannot vouch for the pid either.
    io.lstart = new Date(STARTED_MS).toString()
    expect(await liveGateways(dir, dir, now + 2 + 61)).toHaveLength(1)
    expect(io.spawns).toBe(3)
  })
})
