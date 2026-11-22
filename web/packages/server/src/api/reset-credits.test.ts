import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SIDECAR_METHODS, type ResetCreditRedemption, type ResetCredits, type SidecarParams, type SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

/** `usage.reset_credits` for the synthetic Codex list, asserted equal to the sidecar's own output in sidecar/tests/test_usage_reset_credits.py. */
const LISTED = SIDECAR_METHODS['usage.reset_credits'].result.parse(JSON.parse(readFileSync(join(import.meta.dirname, '../../../../sidecar/tests/fixtures/codex_reset_credits.json'), 'utf8')))
/** The route answers every client reads (contracts/fixtures/codex-reset-credits.json), pinned here against the server's own output. */
const SHARED = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/codex-reset-credits.json'), 'utf8')) as { list: ResetCredits; unsupported: ResetCredits; redemptions: Record<'reset', ResetCreditRedemption> }
/** A route answer with the fixture's source id and reference time, which a live server derives from its scope and clock. */
const shared = (body: ResetCredits): ResetCredits => ({ ...body, source_id: SHARED.list.source_id, computed_at: SHARED.list.computed_at })
type Listed = SidecarResult<'usage.reset_credits'>
interface Source { source_id: string; provider_id: string; account_label: string; reset_credits?: boolean; windows: { label: string; used_percent: number }[] }

const ACCOUNTS = [
  { credential_id: 'work', label: 'work@example.test', status: 'available' as const, unavailable_reason: null, retry_after: null, matches_api_key: false },
  { credential_id: 'home', label: 'home@example.test', status: 'available' as const, unavailable_reason: null, retry_after: null, matches_api_key: false },
]

describe('banked Codex usage-limit resets (TAL-2681)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  /** The provider's state per account: its grants and its weekly and session usage. */
  let accounts: Record<string, { list: Listed; weekly: number; session: number }>
  const post = async (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const sources = async (refresh = false): Promise<Source[]> => ((await (await s.get(`/api/provider/quotas${refresh ? '?refresh=1' : ''}`)).json()) as { sources: Source[] }).sources
  const codex = async (label: string): Promise<Source> => (await sources(true)).find((q) => q.provider_id === 'openai-codex' && q.account_label === label)!
  const list = async (source: string): Promise<ResetCredits> => (await s.get(`/api/provider/quotas/reset-credits?source=${source}`)).json() as Promise<ResetCredits>
  const redeem = async (source: string, credit_id: string, request_id = 'attempt-0001'): Promise<ResetCreditRedemption> => (await post('/api/provider/quotas/reset-credits/redeem', { source, credit_id, request_id })).json() as Promise<ResetCreditRedemption>
  /** What the provider does with a consume: spend the grant, restore the windows to the given values, and answer `reset`. */
  const spend = (params: SidecarParams<'usage.redeem_reset_credit'>): void => {
    const account = accounts[params.credential_id!]!
    const grant = account.list.credits.find((c) => c.id === params.credit_id)!
    Object.assign(grant, { status: 'redeemed', redeemed_at: '2026-11-22T12:00:00Z' })
    account.list.available_count = account.list.available_count! - 1
    Object.assign(account, { weekly: 12, session: 3 })
  }
  /** Where this test's sidecar calls start. */
  let mark = 0
  const calls = (method: 'usage.redeem_reset_credit' | 'usage.reset_credits') => sidecar.calls.slice(mark).filter((c) => c.method === method)
  const redeemCalls = () => calls('usage.redeem_reset_credit').map((c) => c.params as SidecarParams<'usage.redeem_reset_credit'>)

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: { model: { default: 'gpt-5.5', provider: 'openai-codex' } } }))
    sidecar.respond('usage.pool_providers', () => ({ providers: ['openai-codex'], keys: {} }))
    sidecar.respond('usage.pool', (params) => ({ entries: params.provider === 'openai-codex' ? ACCOUNTS : [] }))
    sidecar.respond('usage.account', (params) => {
      const account = accounts[params.credential_id ?? '']
      return { snapshot: account ? { provider: 'openai-codex', available: true, title: 'Account limits', details: [], windows: [{ label: 'Session', used_percent: account.session, reset_at: null }, { label: 'Weekly', used_percent: account.weekly, reset_at: null }] } : null }
    })
    sidecar.respond('usage.reset_credits', (params) => structuredClone(accounts[params.credential_id ?? '']?.list ?? { status: 'no_credentials', http_status: null, available_count: null, credits: [] }))
  })
  beforeEach(() => {
    accounts = { work: { list: structuredClone(LISTED), weekly: 90, session: 40 }, home: { list: structuredClone(LISTED), weekly: 90, session: 40 } }
    sidecar.respond('usage.redeem_reset_credit', (params) => { spend(params); return { outcome: 'reset', http_status: null, windows_reset: 2, credits: structuredClone(accounts[params.credential_id!]!.list) } })
    s.deps.catalog.invalidate()
    mark = sidecar.calls.length
  })
  afterAll(() => s.close())

  it('lists every grant of the source\'s own account distinctly, and a read never redeems', async () => {
    const home = await codex('home@example.test')
    expect(home.reset_credits).toBe(true)
    const body = await list(home.source_id)
    expect(calls('usage.reset_credits').map((c) => c.params)).toEqual([expect.objectContaining({ credential_id: 'home' })])
    expect(body).toMatchObject({ source_id: home.source_id, status: 'available', available_count: 4 })
    // The two identical full resets stay two grants, soonest expiry first; each names the windows it restores.
    expect(body.credits.map((c) => [c.id, c.state, c.redeemable, c.covers, c.expires_at])).toEqual([
      ['rc_full_a', 'available', true, ['session', 'weekly'], '2099-01-10T00:00:00Z'],
      ['rc_full_b', 'available', true, ['session', 'weekly'], '2099-02-10T00:00:00Z'],
      ['rc_weekly', 'available', true, ['weekly'], '2099-03-10T00:00:00Z'],
      ['rc_session', 'available', true, ['session'], null],
    ])
    expect(body.history.map((c) => [c.id, c.state, c.redeemable])).toEqual([['rc_used', 'redeemed', false], ['rc_expired', 'expired', false]])
    expect(shared(body)).toEqual(SHARED.list)
    expect(redeemCalls()).toEqual([])
    // A source that is not a Codex account of this profile has no grants to show or spend.
    expect((await s.get('/api/provider/quotas/reset-credits?source=qsrc_unknown')).status).toBe(404)
    expect((await post('/api/provider/quotas/reset-credits/redeem', { source: 'qsrc_unknown', credit_id: 'rc_full_a', request_id: 'attempt-0001' })).status).toBe(404)
  })

  it('spends exactly the chosen grant of that account and shows the usage the provider reports afterwards', async () => {
    const home = await codex('home@example.test')
    expect(home.windows.map((w) => [w.label, w.used_percent])).toEqual([['Session', 40], ['Weekly', 90]])
    const result = await redeem(home.source_id, 'rc_full_b', 'attempt-home-1')
    expect(redeemCalls()).toEqual([expect.objectContaining({ credential_id: 'home', credit_id: 'rc_full_b', redeem_request_id: 'attempt-home-1' })])
    expect(result).toMatchObject({ outcome: 'reset', windows_reset: 2, credit: { id: 'rc_full_b', state: 'redeemed', redeemable: false } })
    expect(result.reset_credits?.credits.map((c) => c.id)).toEqual(['rc_full_a', 'rc_weekly', 'rc_session'])
    expect(result.reset_credits?.available_count).toBe(3)
    expect({ ...result, reset_credits: shared(result.reset_credits!) }).toEqual(SHARED.redemptions.reset)
    // Both windows show the provider's reread values, not an assumed 0%, on the next plain read; the other account is untouched.
    const after = await sources()
    expect(after.find((q) => q.source_id === home.source_id)?.windows.map((w) => [w.label, w.used_percent])).toEqual([['Session', 3], ['Weekly', 12]])
    expect(after.find((q) => q.account_label === 'work@example.test')?.windows.map((w) => w.used_percent)).toEqual([40, 90])
    // Spending a reset sends no chat command and touches no chat, session or gateway: running turns go on as they were.
    expect(sidecar.calls.slice(mark).map((c) => c.method).filter((m) => /^(chat|session|gateway|state_db|commands)\./.test(m))).toEqual([])
  })

  it('reconciles a lost answer from the provider\'s list before saying anything was spent', async () => {
    const work = await codex('work@example.test')
    // The sidecar call fails after the provider spent the grant: the reread shows it redeemed, so the reset stands.
    sidecar.respond('usage.redeem_reset_credit', (params) => { spend(params); throw new SidecarError('sidecar connection lost', { condition: 'sidecar_unavailable' }) })
    expect(await redeem(work.source_id, 'rc_full_a')).toMatchObject({ outcome: 'reset', credit: { id: 'rc_full_a', state: 'redeemed' } })
    // It fails before the provider saw it: the grant is still there and the outcome stays unknown, never retried by the server.
    sidecar.respond('usage.redeem_reset_credit', () => { throw new SidecarError('sidecar connection lost', { condition: 'sidecar_unavailable' }) })
    expect(await redeem(work.source_id, 'rc_full_b', 'attempt-0002')).toMatchObject({ outcome: 'unknown', credit: { id: 'rc_full_b', state: 'available', redeemable: true } })
    expect(redeemCalls().map((c) => c.credit_id)).toEqual(['rc_full_a', 'rc_full_b'])
  })

  it('answers in_progress to a second redemption for an account while its first is pending', async () => {
    const work = await codex('work@example.test')
    // The provider holds the first consume until released and answers any later one at once.
    let release: (() => void) | null = null
    const answer = (params: SidecarParams<'usage.redeem_reset_credit'>) => { spend(params); return { outcome: 'reset' as const, http_status: null, windows_reset: 2, credits: structuredClone(accounts.work!.list) } }
    sidecar.respond('usage.redeem_reset_credit', (params) => release ? answer(params) : new Promise((resolve) => { release = () => { resolve(answer(params)) } }))
    const first = redeem(work.source_id, 'rc_full_a', 'attempt-0001')
    await expect.poll(() => redeemCalls().length).toBe(1)
    expect(await redeem(work.source_id, 'rc_full_b', 'attempt-0002')).toMatchObject({ outcome: 'in_progress', credit: null })
    release!()
    expect((await first).outcome).toBe('reset')
    expect(redeemCalls().map((c) => c.credit_id)).toEqual(['rc_full_a'])
  })

  it('passes the provider\'s refusals through and keeps an unsupported account\'s reason', async () => {
    const work = await codex('work@example.test')
    for (const outcome of ['not_found', 'not_available', 'nothing_to_reset', 'refused'] as const) {
      sidecar.respond('usage.redeem_reset_credit', () => ({ outcome, http_status: outcome === 'refused' ? 409 : null, windows_reset: null, credits: structuredClone(accounts.work!.list) }))
      expect(await redeem(work.source_id, 'rc_full_a')).toMatchObject({ outcome, credit: { id: 'rc_full_a', state: 'available' }, reset_credits: { available_count: 4 } })
    }
    sidecar.respond('usage.redeem_reset_credit', () => ({ outcome: 'no_credentials', http_status: null, windows_reset: null, credits: null }))
    accounts.work!.list = { status: 'no_credentials', http_status: null, available_count: null, credits: [] }
    expect(await redeem(work.source_id, 'rc_full_a')).toMatchObject({ outcome: 'unsupported', credit: null, reset_credits: null })
    expect(shared(await list(work.source_id))).toEqual(SHARED.unsupported)
  })
})
