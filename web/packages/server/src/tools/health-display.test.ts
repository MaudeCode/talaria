/** TAL-2162: the display states Settings › System renders for disk, Web and Agent health, and the Agent figure. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer } from '../test/harness.js'
import { agentDisplay, diskLevel, systemDisplay } from './health.js'
import { updatesCheckView } from './updates.js'

describe('disk display level', () => {
  it.each([[0, 'healthy'], [84.9, 'healthy'], [85, 'warning'], [94.9, 'warning'], [95, 'critical'], [100, 'critical']] as const)('%d%% used is %s', (percent, level) => {
    expect(diskLevel(percent)).toBe(level)
  })
})

describe('health display states', () => {
  it.each([
    ['ok', [], { display_state: 'ok', display_reason: null }],
    ['partial', [{ metric: 'cpu' }, { metric: 'disk' }], { display_state: 'warning', display_reason: 'Metrics unavailable: cpu, disk' }],
    ['unavailable', [{ metric: 'cpu' }, { metric: 'memory' }, { metric: 'disk' }], { display_state: 'error', display_reason: 'Metrics unavailable' }],
  ] as const)('Web status %s', (status, errors, display) => {
    expect(systemDisplay(status, errors)).toEqual(display)
  })

  it.each([
    [true, { state: 'alive', reason: 'remote_gateway' }, { display_state: 'ok', display_reason: null }],
    [false, { state: 'down', reason: 'gateway_not_running' }, { display_state: 'error', display_reason: 'gateway_not_running' }],
    [false, { state: 'down' }, { display_state: 'error', display_reason: null }],
    [null, { state: 'unknown', reason: 'gateway_stale_stopped_state' }, { display_state: 'idle', display_reason: 'unknown' }],
    [null, undefined, { display_state: 'idle', display_reason: null }],
  ] as const)('Agent alive %s with %o', (alive, details, display) => {
    expect(agentDisplay(alive, details)).toEqual(display)
  })

  it('the shared system-health fixture is this server\'s classification', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/system-health.json', import.meta.url), 'utf8')) as Record<string, { status: string; errors?: { metric: string }[]; display_state: string; display_reason: string | null; disk: { percent: number; display_level: string } | null }>
    for (const row of Object.values(fixture)) {
      expect(systemDisplay(row.status, row.errors ?? [])).toEqual({ display_state: row.display_state, display_reason: row.display_reason })
      if (row.disk) expect(diskLevel(row.disk.percent)).toBe(row.disk.display_level)
    }
  })

  it('the routes send them: a stopped gateway reads as an error, and the system row and disk carry theirs', async () => {
    const s = await bootTestServer({ sidecar: new FakeSidecar() })
    try {
      writeFileSync(join(s.state, 'gateway_state.json'), JSON.stringify({ gateway_state: 'stopped', updated_at: new Date().toISOString() }))
      expect(await (await s.get('/api/health/agent')).json()).toMatchObject({ alive: false, display_state: 'error', display_reason: 'gateway_not_running' })
      const system = (await (await s.get('/api/system/health')).json()) as { status: string; display_state: string; disk: { percent: number; display_level: string } }
      expect(system.display_state).toBe(systemDisplay(system.status, []).display_state)
      expect(system.disk.display_level).toBe(diskLevel(system.disk.percent))
      // Ignored Agent updates keep an Agent target (state `off`), so only the down gateway can tone it.
      await s.get('/api/settings', { method: 'POST', body: JSON.stringify({ ignore_agent_updates: true }), headers: { 'content-type': 'application/json' } })
      const check = (await (await s.get('/api/updates/check')).json()) as { agent: { state: string; figure_tone: unknown } }
      expect(check.agent).toMatchObject({ state: 'off', figure_tone: 'warning' })
    } finally { await s.close() }
  })
})

describe('Agent figure tone', () => {
  const agent = (fields: Record<string, unknown>, down = false) => (updatesCheckView({ agent: fields }, down).agent as { figure_tone: unknown }).figure_tone
  it.each([
    ['release_ready', { behind: 2, release_based: true }],
    ['commits_behind', { behind: 2 }],
    ['finish', { metadata_repair: true }],
  ] as const)('%s warns', (_state, fields) => {
    expect(agent(fields)).toBe('warning')
  })
  it('a down gateway warns even when current, and a current, live Agent has no tone', () => {
    expect(agent({ behind: 0 }, true)).toBe('warning')
    expect(agent({ behind: 0 })).toBeNull()
    expect(agent({ behind: 0, dirty: true })).toBeNull()
  })
  it('only the Agent target carries the tone', () => {
    expect(updatesCheckView({ webui: { behind: 2 } }, true).webui).not.toHaveProperty('figure_tone')
  })
})
