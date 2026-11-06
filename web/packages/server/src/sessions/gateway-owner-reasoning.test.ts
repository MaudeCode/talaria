import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionEnvelopeSchema, type GatewaySessionResult, type GatewaySnapshot } from '@maudecode/talaria-web-contracts'
import { admission, attached, bootOwnerAttachment, ownerHelpers, sid, snapshot } from '../test/gateway-owner.js'
import { type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'

const shared = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/gateway-owner.json', import.meta.url), 'utf8')) as {
  reasoning: Record<'pinned' | 'clamped' | 'provider_default' | 'deferred' | 'restarting', { info: Record<string, unknown>; attachment: { reasoning_control: Record<string, unknown> } }> & { requests: Record<'set' | 'reset' | 'combined', Record<string, unknown>> }
}
const fixtures = shared.reasoning
const owned = (info: Record<string, unknown>, extra: Partial<GatewaySnapshot> = {}) => snapshot({ info: { title: 'Native chat', model: 'native-model', provider: 'custom', ...info }, ...extra })
const request = (name: 'set' | 'reset' | 'combined') => ({ ...fixtures.requests[name], session_id: sid })

describe('a canonical owner chat\'s own reasoning level (TAL-1319)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  beforeEach(async () => {
    ({ s, db, sidecar } = await bootOwnerAttachment())
    sidecar.respond('models.reasoning_efforts', () => ({ efforts: ['low', 'medium', 'high'], supports_reasoning: true }))
  })
  afterEach(async () => { db.close(); await s.close() })
  const { post } = ownerHelpers(() => ({ s, sidecar }))
  const detail = async () => SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json()).session
  const control = async () => (await detail()).owner_attachment?.reasoning_control
  const owner = (result: (params: { action: string }) => GatewaySessionResult) => { sidecar.respond('gateway.session', (params) => result(params)) }
  const calls = (action: string) => sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === action).map((c) => c.params as Record<string, unknown>)
  const noProfileWrite = () => { expect(profileWrites()).toEqual([]) }
  const profileWrites = () => sidecar.calls.filter((c) => c.method === 'config.set')
  beforeEach(() => {
    const path = join(s.state, 'config.yaml')
    writeFileSync(path, 'agent: {}\n')
    sidecar.respond('config.get', () => ({ path, exists: true, config: { agent: { reasoning_effort: 'low' } } }))
  })

  it.each(['pinned', 'clamped', 'provider_default', 'restarting'] as const)('projects the owner\'s %s level and never the profile\'s', async (name) => {
    const { info, attachment } = fixtures[name]
    owner(() => ({ ...attached(owned(info)), restarting: name === 'restarting' }))
    expect(await control()).toEqual(attachment.reasoning_control)
    expect(sidecar.calls.find((c) => c.method === 'models.reasoning_efforts')?.params).toMatchObject({ model: 'native-model', provider: 'custom' })
  })

  it('omits the control for an owner that reports no level', async () => {
    owner(() => attached(snapshot()))
    expect(await control()).toBeUndefined()
    expect(sidecar.calls.some((c) => c.method === 'models.reasoning_efforts')).toBe(false)
  })

  it.each([['set', 'low'], ['reset', null]] as const)('%s sends one fenced owner mutation and answers the refreshed owner state', async (name, effort) => {
    let snap = owned({ reasoning_effort: 'high', reasoning_effort_wire: 'high' })
    owner((params) => {
      if (params.action !== 'mutate') return attached(snap)
      snap = owned({ reasoning_effort: effort ?? 'medium', reasoning_effort_wire: effort ?? 'medium' }, { revision: 3 })
      return { ...attached(snap), receipt: { operation: 'reasoning', effort, revision: 3 } }
    })
    const response = await post('/api/chat/owner-action', request(name))
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ session: { owner_attachment: { revision: 3, reasoning_control: { reasoning_effort: effort ?? 'medium', deferred: null } } } })
    expect(calls('mutate')).toEqual([expect.objectContaining({ operation: 'reasoning', payload: { effort }, request_id: 'reasoning-pick', expected_revision: 2, execution_generation: 1 })])
    noProfileWrite()
  })

  it('a busy pick keeps the actual level, names what waits, and forgets it once the owner is idle', async () => {
    let snap = owned(fixtures.deferred.info, { running: true, pending: [admission()] })
    owner((params) => ({ ...attached(snap), receipt: params.action === 'mutate' ? { operation: 'reasoning', status: 'deferred', effort: 'low', revision: 2 } : null }))
    const response = await post('/api/chat/owner-action', request('set'))
    expect(await response.json()).toMatchObject({ session: { owner_attachment: { reasoning_control: fixtures.deferred.attachment.reasoning_control } } })
    snap = owned({ reasoning_effort: 'low', reasoning_effort_wire: 'low' })
    expect(await control()).toMatchObject({ reasoning_effort: 'low', deferred: null })
  })

  it('a restarted or reconnected owner answers its own level and drops the old owner\'s wait', async () => {
    const running = { running: true, pending: [admission()] }
    let snap = owned(fixtures.deferred.info, running)
    owner((params) => ({ ...attached(snap), receipt: params.action === 'mutate' ? { operation: 'reasoning', status: 'deferred', effort: 'low', revision: 2 } : null }))
    await post('/api/chat/owner-action', request('set'))
    expect(await control()).toMatchObject({ deferred: { effort: 'low' } })
    snap = owned(fixtures.deferred.info, { ...running, authority_epoch: 2, replay_epoch: 'successor' })
    expect(await control()).toMatchObject({ reasoning_effort: 'high', deferred: null })
  })

  it.each([
    ['a stale fence', { state: 'refused' as const, reason: 'revision_conflict', snapshot: null, receipt: null }],
    ['an owner refusal', { state: 'refused' as const, reason: 'invalid_params', snapshot: null, receipt: null }],
    ['an unsupported owner', { state: 'incompatible' as const, reason: 'owner_capabilities', snapshot: null, receipt: null }],
  ])('%s is refused once, keeps the actual level and never writes the profile', async (_, refusal) => {
    const snap = owned(fixtures.pinned.info)
    sidecar.respond('gateway.session', (params) => params.action === 'mutate' ? refusal : attached(snap))
    const response = await post('/api/chat/owner-action', request('set'))
    expect(response.status).toBe(409)
    expect(calls('mutate')).toHaveLength(1)
    expect(await control()).toMatchObject({ reasoning_effort: 'high' })
    noProfileWrite()
  })

  it('refuses an unknown level before the owner sees it', async () => {
    owner(() => attached(owned(fixtures.pinned.info)))
    const response = await post('/api/chat/owner-action', { ...request('set'), payload: { effort: 'loud' } })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("Unknown reasoning effort 'loud'")
    expect(calls('mutate')).toEqual([])
  })

  it('a refusing receipt is an error, not an applied change', async () => {
    owner((params) => ({ ...attached(owned(fixtures.pinned.info)), receipt: params.action === 'mutate' ? { operation: 'reasoning', status: 'refused', reason: 'reasoning_resolution_failed' } : null }))
    expect((await post('/api/chat/owner-action', request('set'))).status).toBe(409)
    expect(await control()).toMatchObject({ reasoning_effort: 'high', deferred: null })
  })

  it('a lost acknowledgment reads the owner back and never resends the write', async () => {
    const snap = owned(fixtures.pinned.info)
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'mutate') throw new Error('connection lost after send')
      return attached(snap)
    })
    const response = await post('/api/chat/owner-action', request('set'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ session: { owner_attachment: { reasoning_control: { reasoning_effort: 'high' } } } })
    expect(calls('mutate')).toHaveLength(1)
    noProfileWrite()
  })

  it('an unreadable owner after a lost acknowledgment reports the outcome as unknown', async () => {
    sidecar.respond('gateway.session', () => { throw new Error('owner gone') })
    const response = await post('/api/chat/owner-action', request('set'))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ outcome_unknown: true })
    expect(calls('mutate')).toHaveLength(1)
    noProfileWrite()
  })

  describe('a model and level chosen together', () => {
    const parsed = (fields: Record<string, unknown>) => ({ target: '', provider: null, reset: false, reasoning: null, errors: [], unsupported_flags: [], ...fields })
    const command = (args: string, session_id: string) => post('/api/session/model-command', { args, session_id })

    it('/model answers one owner request carrying both', async () => {
      sidecar.respond('models.parse_switch_args', () => parsed({ target: 'picked', provider: 'custom', reasoning: 'high' }))
      expect(await (await command('picked --provider custom --reasoning high', sid)).json()).toEqual({ model: 'picked', model_provider: 'custom', owner_payload: fixtures.requests.combined.payload })
    })

    it('a direct chat keeps refusing the flag', async () => {
      sidecar.respond('models.parse_switch_args', () => parsed({ target: 'picked', reasoning: 'high' }))
      const created = await (await post('/api/session/new', { model: 'pinned-model' })).json() as { session: { session_id: string } }
      const response = await command('picked --reasoning high', created.session.session_id)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('--reasoning')
    })

    it.each([
      [{ operation: 'model', status: 'confirmation_required', confirm: 'owner-token', confirm_message: 'Guard warning', target_model: 'picked', target_provider: 'custom' }, { state: 'confirmation_required', confirm: 'owner-token', model: 'picked', provider: 'custom', reasoning: 'high' }],
      [{ operation: 'model', status: 'deferred', model: 'picked' }, { state: 'deferred', model: 'picked', provider: 'custom', reasoning: 'high' }],
    ])('commits as one mutation whose answer keeps the chosen level (%j)', async (receipt, change) => {
      owner((params) => ({ ...attached(owned(fixtures.pinned.info)), receipt: params.action === 'mutate' ? receipt : null }))
      const response = await post('/api/chat/owner-action', request('combined'))
      expect(await response.json()).toMatchObject({ model_change: change, session: { owner_attachment: { reasoning_control: { reasoning_effort: 'high' } } } })
      expect(calls('mutate')).toEqual([expect.objectContaining({ operation: 'model', payload: fixtures.requests.combined.payload })])
    })
  })
})
