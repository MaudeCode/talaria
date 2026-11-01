/** TAL-1627: the lifecycle capability's decision matrix, against a fake ownership probe and a disposable state directory. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GatewayLifecycle } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { gatewayLifecycle, loopbackEndpoint, type GatewayLifecycleDeps } from './gateway-lifecycle.js'

type Probe = 'owned' | 'foreign' | 'unbound' | 'stopped' | 'unverified'
const MANAGED: GatewayLifecycle = { managed: true, reason: 'local_gateway', start_command: null }
const EXTERNAL: GatewayLifecycle = { managed: false, reason: 'external_gateway', start_command: null }
const UNVERIFIED: GatewayLifecycle = { managed: false, reason: 'unverified', start_command: null }
const START = 'hermes --profile default gateway start'
const UNPROVEN: GatewayLifecycle = { managed: false, reason: 'local_gateway_unproven', start_command: START }

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) { chmodSync(d, 0o700); rmSync(d, { recursive: true, force: true }) } })

function setup(url: string | null, probe: { state: Probe | Error; start_command?: string | null } = { state: 'owned' }) {
  const state = mkdtempSync(join(tmpdir(), 'talaria-lifecycle-'))
  dirs.push(state)
  const home = join(state, 'home')
  const work = join(state, 'home', 'profiles', 'work')
  mkdirSync(work, { recursive: true })
  const sidecar = new FakeSidecar()
  const ports: number[] = []
  sidecar.respond('gateway.ownership', (params) => {
    ports.push(params.port)
    if (probe.state instanceof Error) throw probe.state
    return { state: probe.state, start_command: probe.start_command === undefined ? START : probe.start_command }
  })
  const answering = { now: false as boolean | Error }
  const logs: string[] = []
  const deps: GatewayLifecycleDeps = {
    env: url === null ? {} : { HERMES_WEBUI_GATEWAY_BASE_URL: url },
    stateDir: state,
    sidecar: () => sidecar,
    answering: () => answering.now instanceof Error ? Promise.reject(answering.now) : Promise.resolve(answering.now),
    log: (line) => logs.push(line),
  }
  const custody = join(state, 'gateway-lifecycle-custody.json')
  return { state, home, work, sidecar, deps, probe, answering, ports, custody, logs, check: (at = home) => gatewayLifecycle(deps, at) }
}

describe('loopbackEndpoint', () => {
  it.each([
    ['http://127.0.0.1:8642', 'http://127.0.0.1:8642', 8642],
    ['http://127.1.2.3:8642/api/', 'http://127.1.2.3:8642/api', 8642],
    ['https://LOCALHOST', 'https://localhost:443', 443],
    ['http://[::1]:8642', 'http://[::1]:8642', 8642],
    ['http://user:secret@127.0.0.1:8642/?token=x#frag', 'http://127.0.0.1:8642', 8642],
  ])('%s is the loopback endpoint %s', (url, endpoint, port) => { expect(loopbackEndpoint(url)).toEqual({ endpoint, port }) })

  it.each([
    'https://gateway.example', 'http://127.0.0.1.example.com:8642', 'http://localhost.example.com', 'http://localhost.:8642',
    'http://127.0.0.1@evil.example:8642', 'http://10.0.0.5:8642', 'http://0.0.0.0:8642', 'http://[::ffff:127.0.0.1]:8642',
    'ftp://127.0.0.1', 'http://[bad', '127.0.0.1:8642', '',
  ])('%s is not a loopback endpoint', (url) => { expect(loopbackEndpoint(url)).toBeNull() })
})

describe('gatewayLifecycle', () => {
  it('keeps the local lifecycle without an explicit Gateway URL, without asking the sidecar', async () => {
    const t = setup(null)
    expect(await t.check()).toEqual(MANAGED)
    expect(t.ports).toEqual([])
  })

  it.each(['https://gateway.example', 'http://127.0.0.1.example.com:8642', 'http://[bad', 'http://192.168.1.4:8642'])('%s is external without a probe', async (url) => {
    const t = setup(url)
    expect(await t.check()).toEqual(EXTERNAL)
    expect(t.ports).toEqual([])
  })

  it('a live proof records custody that outlives the gateway, never with credentials', async () => {
    const t = setup('http://user:secret@127.0.0.1:8642')
    expect(await t.check()).toEqual(MANAGED)
    expect(t.ports).toEqual([8642])
    const record = readFileSync(t.custody, 'utf8')
    expect(record).not.toContain('secret')
    expect(JSON.parse(record)).toMatchObject({ version: 1, owners: { [realpathSync(t.home)]: { endpoint: 'http://127.0.0.1:8642' } } })
    t.probe.state = 'stopped'
    expect(await t.check()).toEqual(MANAGED)
    t.probe.state = 'unbound'
    expect(await t.check()).toEqual(MANAGED)
  })

  it('a stopped loopback Gateway never proven gets the validated start command; a running one gets none', async () => {
    const t = setup('http://127.0.0.1:8642', { state: 'stopped' })
    expect(await t.check()).toEqual(UNPROVEN)
    t.probe.state = 'unbound'
    expect(await t.check()).toEqual({ ...UNPROVEN, start_command: null })
    t.probe.state = 'stopped'
    t.probe.start_command = 'hermes --profile work gateway start'
    expect(await t.check()).toEqual({ ...UNPROVEN, start_command: 'hermes --profile work gateway start' })
    for (const hostile of ['hermes --profile work;rm gateway start', 'hermes --profile Work gateway start', 'rm -rf /', 'hermes --profile work gateway start --x', null]) {
      t.probe.start_command = hostile
      expect(await t.check()).toEqual({ ...UNPROVEN, start_command: null })
    }
  })

  it('a tunnel or port map answering where no local gateway runs is external, custody or not', async () => {
    const t = setup('http://127.0.0.1:8642')
    await t.check()
    t.probe.state = 'stopped'
    t.answering.now = true
    expect(await t.check()).toEqual(EXTERNAL)
    t.answering.now = new Error('probe failed')
    expect(await t.check()).toEqual(UNVERIFIED)
  })

  it('another process holding the port is external and drops custody', async () => {
    const t = setup('http://127.0.0.1:8642')
    await t.check()
    t.probe.state = 'foreign'
    expect(await t.check()).toEqual(EXTERNAL)
    t.probe.state = 'stopped'
    expect(await t.check()).toEqual(UNPROVEN)
  })

  it('custody names one profile home: another profile proves its own', async () => {
    const t = setup('http://127.0.0.1:8642')
    await t.check()
    t.probe.state = 'stopped'
    expect(await t.check(t.work)).toEqual(UNPROVEN)
    expect(await t.check()).toEqual(MANAGED)
  })

  it('a changed endpoint invalidates the home\'s custody', async () => {
    const t = setup('http://127.0.0.1:8642')
    await t.check()
    t.probe.state = 'stopped'
    t.deps.env = { HERMES_WEBUI_GATEWAY_BASE_URL: 'http://127.0.0.1:9000' }
    expect(await t.check()).toEqual(UNPROVEN)
    t.deps.env = { HERMES_WEBUI_GATEWAY_BASE_URL: 'http://127.0.0.1:8642' }
    expect(await t.check()).toEqual(UNPROVEN)
  })

  it.each([
    ['not JSON', '{'],
    ['another version', JSON.stringify({ version: 2, owners: {} })],
    ['a malformed owner', JSON.stringify({ version: 1, owners: { '/x': { endpoint: 1 } } })],
  ])('custody that is %s proves nothing until a live proof rewrites it', async (_name, text) => {
    const t = setup('http://127.0.0.1:8642', { state: 'stopped' })
    writeFileSync(t.custody, text.replace('/x', realpathSync(t.home)))
    expect(await t.check()).toEqual(UNPROVEN)
    t.probe.state = 'owned'
    expect(await t.check()).toEqual(MANAGED)
    t.probe.state = 'stopped'
    expect(await t.check()).toEqual(MANAGED)
  })

  it('unwritable custody keeps a live proof but fails closed once the gateway stops', async () => {
    const t = setup('http://127.0.0.1:8642')
    chmodSync(t.state, 0o500)
    expect(await t.check()).toEqual(MANAGED)
    expect(t.logs.some((line) => line.includes('custody record'))).toBe(true)
    t.probe.state = 'stopped'
    expect(await t.check()).toEqual(UNPROVEN)
  })

  it('unknown evidence fails closed and leaves custody in place', async () => {
    const t = setup('http://127.0.0.1:8642')
    await t.check()
    t.probe.state = 'unverified'
    expect(await t.check()).toEqual(UNVERIFIED)
    t.probe.state = new Error('sidecar restarting')
    expect(await t.check()).toEqual(UNVERIFIED)
    t.deps.sidecar = () => null
    expect(await t.check()).toEqual(UNVERIFIED)
    expect(await t.check(join(t.state, 'missing'))).toEqual(UNVERIFIED)
    t.deps.sidecar = () => t.sidecar
    t.probe.state = 'stopped'
    expect(await t.check()).toEqual(MANAGED)
  })
})
