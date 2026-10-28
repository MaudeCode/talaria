import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { str } from '../util.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, method = 'POST'): Promise<Response> => s.get(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

type Snapshot = SidecarResult<'connectors.operation'>
/** The shared Web/App fixture: the page, tool and card views this suite composes. */
const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/connectors.json'), 'utf8')) as Record<'page' | 'tools' | 'connect_card', Json>
const pageConnect = (state: Snapshot['targets'][number]['state'], settled = false): Snapshot => ({
  op_id: 'op-page', settled, owner: 'account', tool_call_id: null,
  targets: [{ name: 'gmail', kind: 'connector', state, detail: '', connect_url: 'https://vendor.example.test/authorize/conn-1', required_env: [] }],
})

describe('TAL-818: the Connectors page and connect card', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  it('hides the page for a profile without connectors (server flag)', async () => {
    sidecar.respond('connectors.available', () => ({ available: false }))
    expect(await json(await s.get('/api/connectors/available'))).toEqual({ available: false })
    expect(await json(await s.get('/api/connectors'))).toEqual({ available: false, sign_in_required: false, connectors: [], policy_revision: null, rules_error: null })
    expect(sidecar.calls.some((c) => c.method === 'connectors.catalog')).toBe(false)
    // A sidecar that cannot answer fails closed.
    sidecar.respond('connectors.available', () => { throw new SidecarError('down', { condition: 'sidecar_unavailable' }) })
    expect(await json(await s.get('/api/connectors/available'))).toEqual({ available: false })
    sidecar.respond('connectors.available', undefined)
    expect(await json(await s.get('/api/connectors/available'))).toEqual({ available: true })
  })

  it('composes apps, accounts, and member and organization rules', async () => {
    sidecar.respond('connectors.accounts', () => ({ accounts: [
      { connection_id: 'old', connector: 'notion', status: 'active', status_reason: null, label: 'old@example.test', alias: null, active: false, disabled: false, created_at: '2026-10-01T00:00:00Z' },
      { connection_id: 'new', connector: 'notion', status: 'active', status_reason: null, label: 'me@example.test', alias: 'work', active: true, disabled: false, created_at: '2026-09-01T00:00:00Z' },
      { connection_id: 'retired', connector: 'notion', status: 'inactive', status_reason: null, label: 'x', alias: null, active: false, disabled: true, created_at: '2026-10-02T00:00:00Z' },
    ] }))
    sidecar.respond('connectors.policy.get', () => ({
      layers: [
        { kind: 'org', revision: 'org-1', body: { mode: 'allow', connectors: ['notion'], tools: { notion: { disable: ['notion_delete'] } }, tags: { disable: ['destructiveHint'] } } },
        { kind: 'member', revision: 'rev-7', body: { mode: 'deny', disabled_connectors: ['notion'], tools: { notion: { disable: ['notion_send'] } } } },
      ],
      effective: { mode: 'allow', connectors: [], revision: 'eff-1' },
    }))
    const page = await json(await s.get('/api/connectors'))
    expect(page).toEqual(shared.page)
    expect(page.available).toBe(true)
    expect(page.policy_revision).toBe('rev-7')
    const [gmail, notion] = page.connectors as Json[]
    expect(gmail).toMatchObject({ slug: 'gmail', name: 'Gmail', connected: false, accounts: [], enabled: false, org_locked: true, rules_editable: false, tools_off: 0 })
    expect(notion).toMatchObject({ slug: 'notion', connected: true, enabled: false, org_locked: false, rules_editable: true, tools_off: 1 })
    expect((notion!.accounts as Json[]).map((a) => [a.connection_id, a.name])).toEqual([['new', 'work'], ['old', 'old@example.test']])

    sidecar.respond('connectors.tools', () => ({ connector: 'notion', tools: [
      { slug: 'notion_read', name: 'Read', description: '', facet: 'read', hints: ['readOnlyHint'], categories: [], deprecated: false },
      { slug: 'notion_send', name: 'Send', description: '', facet: 'write', hints: [], categories: [], deprecated: false },
      { slug: 'notion_delete', name: 'Delete', description: '', facet: 'destructive', hints: [], categories: [], deprecated: false },
      { slug: 'notion_purge', name: 'Purge', description: '', facet: 'destructive', hints: ['destructiveHint'], categories: [], deprecated: false },
      { slug: 'notion_share', name: 'Share', description: '', facet: 'write', hints: ['openWorldHint'], categories: [], deprecated: false },
    ] }))
    // Notion is off in the member rules: Hermes gets none of its tools, and no tool switch may write (the Agent refuses that rule).
    const appOff = await json(await s.get('/api/connectors/notion/tools'))
    expect((appOff.tools as Json[]).every((t) => t.enabled === false && t.editable === false)).toBe(true)

    // With Notion on: the member turns Send off by name and Share off by tag; the organization locks Delete by name and Purge by tag.
    sidecar.respond('connectors.policy.get', () => ({
      layers: [
        { kind: 'org', revision: 'org-1', body: { mode: 'allow', connectors: ['notion'], tools: { notion: { disable: ['notion_delete'] } }, tags: { disable: ['destructiveHint'] } } },
        { kind: 'member', revision: 'rev-7', body: { mode: 'deny', disabled_connectors: [], tools: { notion: { disable: ['notion_send'] } }, tags: { disable: ['openWorldHint'] } } },
      ],
      effective: { mode: 'allow', connectors: ['notion'], revision: 'eff-1' },
    }))
    const tools = await json(await s.get('/api/connectors/notion/tools'))
    expect(tools).toEqual(shared.tools)
    expect((tools.tools as Json[]).map((t) => [t.slug, t.enabled, t.locked, t.editable])).toEqual([
      ['notion_read', true, false, true], ['notion_send', false, false, true], ['notion_delete', false, true, false], ['notion_purge', false, true, false], ['notion_share', false, false, false],
    ])

    // Rules that cannot be read fail closed: every app reads off and read-only, and the page says why.
    sidecar.respond('connectors.policy.get', () => { throw new SidecarError('Select an organization', { condition: 'connectors_org_required' }) })
    const readOnly = await json(await s.get('/api/connectors'))
    expect(readOnly.policy_revision).toBeNull()
    expect((readOnly.connectors as Json[]).map((c) => [c.enabled, c.rules_editable])).toEqual([[false, false], [false, false]])
    expect(readOnly.rules_error).toBe('Select an organization')
    const toolsUnread = await json(await s.get('/api/connectors/notion/tools'))
    expect((toolsUnread.tools as Json[]).every((t) => t.enabled === false && t.editable === false)).toBe(true)
    for (const method of ['connectors.accounts', 'connectors.policy.get', 'connectors.tools'] as const) sidecar.respond(method, undefined)
  })

  it.each([false, true])('keeps an unsigned page readable, public catalog %s, then adopts external sign-in', async (publicCatalog) => {
    sidecar.respond('connectors.catalog', () => {
      if (!publicCatalog) throw new SidecarError('Sign in to Nous Portal to use connectors.', { condition: 'connectors_sign_in' })
      return { connectors: [{ slug: 'gmail', name: 'Gmail', description: '', category: '', logo_url: null }] }
    })
    sidecar.respond('connectors.accounts', () => ({ accounts: [] }))
    sidecar.respond('connectors.policy.get', () => { throw new SidecarError('Sign in to Nous Portal to use connectors.', { condition: 'connectors_sign_in' }) })
    try {
      for (let read = 0; read < 3; read++) {
        const response = await s.get('/api/connectors')
        expect(response.status).toBe(200)
        expect(await json(response)).toMatchObject({ available: true, sign_in_required: true, policy_revision: null,
          connectors: publicCatalog ? [expect.objectContaining({ connected: false, enabled: false, rules_editable: false })] : [] })
      }
      for (const method of ['connectors.catalog', 'connectors.accounts', 'connectors.policy.get'] as const) sidecar.respond(method, undefined)
      const refreshed = await json(await s.get('/api/connectors'))
      expect(refreshed).toMatchObject({ sign_in_required: false, policy_revision: 'rev-1' })
      expect((refreshed.connectors as Json[]).some((row) => row.connected)).toBe(true)
    } finally {
      for (const method of ['connectors.catalog', 'connectors.accounts', 'connectors.policy.get'] as const) sidecar.respond(method, undefined)
    }
  })

  it('shows sign-in for expired account credentials and preserves portal failures as errors', async () => {
    sidecar.respond('connectors.accounts', () => { throw new SidecarError('Sign in again.', { condition: 'connectors_sign_in' }) })
    try {
      const response = await s.get('/api/connectors')
      expect(response.status).toBe(200)
      expect(await json(response)).toMatchObject({ sign_in_required: true })
      sidecar.respond('connectors.accounts', () => { throw new SidecarError('Connector request failed.', { condition: 'connectors_failed' }) })
      expect((await s.get('/api/connectors')).status).toBe(502)
    } finally {
      sidecar.respond('connectors.accounts', undefined)
    }
  })

  it('writes one member rule from the page revision; a stale revision is a 409 conflict', async () => {
    const res = await post(s, '/api/connectors/gmail/policy', { revision: 'rev-1', enabled: false })
    expect(await json(res)).toEqual({ ok: true, revision: 'rev-2' })
    expect(sidecar.calls.at(-1)).toEqual({ method: 'connectors.policy.set', params: expect.objectContaining({ connector: 'gmail', expected_revision: 'rev-1', enabled: false }) as unknown })

    sidecar.respond('connectors.policy.set', () => { throw new SidecarError('Connector rules changed. Refresh and try again.', { condition: 'policy_conflict' }) })
    const conflict = await post(s, '/api/connectors/gmail/policy', { revision: 'rev-1', tool: 'gmail_send', tool_enabled: false })
    expect(conflict.status).toBe(409)
    expect(await json(conflict)).toMatchObject({ code: 'policy_conflict' })
    sidecar.respond('connectors.policy.set', undefined)

    const ambiguous = await post(s, '/api/connectors/gmail/policy', { revision: 'rev-1', enabled: true, tool: 'gmail_send', tool_enabled: false })
    expect(ambiguous.status).toBe(400)
  })

  it('removes an account and maps a missing one to 404', async () => {
    expect(await json(await post(s, '/api/connectors/accounts/conn-notion', {}, 'DELETE'))).toEqual({ ok: true })
    sidecar.respond('connectors.remove', () => { throw new SidecarError('Connector account not found.', { condition: 'connection_not_found' }) })
    const missing = await post(s, '/api/connectors/accounts/conn-notion', {}, 'DELETE')
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({ code: 'connection_not_found' })
    sidecar.respond('connectors.remove', undefined)
  })

  it('connects from the page: the link while it waits, skip only, and connected once the account is active', async () => {
    sidecar.respond('connectors.connect', () => pageConnect('initiated'))
    const started = await json(await post(s, '/api/connectors/gmail/connect', {}))
    expect(started).toEqual({ op_id: 'op-page', settled: false, outcome: null, can_continue: false, tool_call_id: null, targets: [
      { name: 'gmail', title: 'Gmail', kind: 'connector', state: 'initiated', detail: '', connect_url: 'https://vendor.example.test/authorize/conn-1', actions: ['skip'], env_fields: [] },
    ] })
    sidecar.respond('connectors.operation', () => pageConnect('initiated'))
    // Continue belongs to a chat card; the page's operation refuses it before it reaches the Agent.
    const refused = await post(s, '/api/connectors/operations/op-page', { action: 'continue' })
    expect(refused.status).toBe(409)
    expect(sidecar.calls.some((c) => c.method === 'connectors.respond')).toBe(false)

    sidecar.respond('connectors.operation', () => pageConnect('connected', true))
    const done = await json(await s.get('/api/connectors/operations/op-page'))
    expect(done).toMatchObject({ settled: true, outcome: 'connected', targets: [{ state: 'connected', connect_url: null, actions: [] }] })
    for (const method of ['connectors.connect', 'connectors.operation'] as const) sidecar.respond(method, undefined)
  })

  it('streams a chat connect card and lets it continue (TAL-818)', async () => {
    const sid = str(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const card: Snapshot = { op_id: 'op-chat', settled: false, owner: 'session', tool_call_id: 'call-1', targets: [
      { name: 'gmail', kind: 'connector', state: 'initiated', detail: '', connect_url: 'https://vendor.example.test/authorize/conn-2', required_env: [] },
      { name: 'linear', kind: 'mcp', state: 'pending', detail: '', connect_url: null, required_env: [{ name: 'LINEAR_API_KEY', prompt: 'API key', required: true, secret: true }] },
    ] }
    let release: () => void = () => undefined
    sidecar.respond('connectors.operation', () => card)
    sidecar.respond('connectors.respond', (params) => { release(); return { ...card, settled: params.action === 'continue' } })
    const asked: unknown[] = []
    sidecar.respond('chat.start', async (params, emit) => {
      asked.push(params.connect_card)
      emit({ event: 'connection', data: card })
      await new Promise<void>((resolve) => { release = resolve })
      emit({ event: 'token', data: { text: 'continued' } })
      return { status: 'completed', messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'continued' }], final_response: 'continued', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }
    })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'connect gmail', connect_card: true }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${str(start.stream_id)}`, (f) => f.event === 'connect_card')
    const shown = frames.at(-1)?.data as Json
    expect(shown).toEqual(shared.connect_card)
    expect(shown).toMatchObject({ op_id: 'op-chat', can_continue: true, tool_call_id: 'call-1' })
    expect((shown.targets as Json[]).map((t) => [t.name, t.title, t.actions, (t.env_fields as Json[]).length])).toEqual([['gmail', 'Gmail', ['skip'], 0], ['linear', 'Linear', ['approve', 'skip'], 1]])

    const continued = await json(await post(s, '/api/connectors/operations/op-chat', { action: 'continue' }))
    expect(continued.settled).toBe(true)
    await s.sse(`/api/chat/stream?stream_id=${str(start.stream_id)}&after_event_id=${str(start.stream_id)}:0`, (f) => f.event === 'stream_end')
    // Only a client that draws the card asks the Agent for one; any other client keeps the Agent's plain links.
    expect(asked).toEqual([true])
    for (const method of ['connectors.operation', 'connectors.respond', 'chat.start'] as const) sidecar.respond(method, undefined)
  })
})

describe('TAL-1507: native scheduled connector sign-in offers', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let status: SidecarResult<'connectors.offer.status'>
  let claims: number
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    status = { available: true, eligible: true, guest_id: 'guest-a', due_in: 0, claimed: false }
    claims = 0
    sidecar.respond('connectors.offer.status', () => status)
    sidecar.respond('connectors.offer.claim', (params) => {
      const claimed = status.available && status.eligible && status.due_in === 0 && params.guest_id === status.guest_id
      if (claimed) { claims += 1; status = { ...status, due_in: null } }
      return { ...status, claimed }
    })
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  it('claims once across simultaneous tabs, retains lost delivery and reopens from durable page state', async () => {
    // Ignore one response body, as when the browser loses delivery after the server handles the read.
    await s.get('/api/connectors')
    const pages = await Promise.all(Array.from({ length: 6 }, async () => await json(await s.get('/api/connectors'))))
    const offer = pages[0]!.sign_in_offer as Json
    expect(offer).toMatchObject({ available: true, due: false, visible: true, actions: ['sign_in', 'dismiss'] })
    expect(new Set(pages.map((page) => (page.sign_in_offer as Json).offer_id)).size).toBe(1)
    expect(claims).toBe(1)
    const { ConnectorOffers } = await import('../tools/connectors.js')
    const { JsonDocuments } = await import('../sessions/storage/json-documents.js')
    const originalOwner = s.deps.connectorOffers
    const documents = new JsonDocuments(s.deps.config.stateDir)
    try {
      s.deps.connectorOffers = new ConnectorOffers(documents)
      expect((await json(await s.get('/api/connectors'))).sign_in_offer).toEqual(offer)
      sidecar.respond('connectors.offer.status', () => { throw new SidecarError('offline', { condition: 'sidecar_unavailable' }) })
      expect((await json(await s.get('/api/connectors'))).sign_in_offer).toMatchObject({ visible: true, available: false, due: false, actions: ['dismiss'], offer_id: offer.offer_id })
      sidecar.respond('connectors.offer.status', () => status)
      status = { ...status, available: false, eligible: false }
      expect((await json(await s.get('/api/connectors'))).sign_in_offer).toMatchObject({ visible: true, available: false, due: false, actions: ['dismiss'], offer_id: offer.offer_id })
      status = { ...status, available: true, eligible: true }
      await post(s, '/api/connectors/sign-in-offer/dismiss', { offer_id: offer.offer_id })
      expect(await json(await post(s, '/api/connectors/sign-in-offer/dismiss', { offer_id: offer.offer_id }))).toMatchObject({ visible: false })
      expect((await json(await s.get('/api/connectors'))).sign_in_offer).toMatchObject({ visible: false, due: false })
      expect(claims).toBe(1)
      // Only the Agent can re-arm. A stale acknowledgement cannot dismiss that later native offer.
      status = { ...status, due_in: 0 }
      const later = (await json(await s.get('/api/connectors'))).sign_in_offer as Json
      expect(later.offer_id).not.toBe(offer.offer_id)
      expect(await json(await post(s, '/api/connectors/sign-in-offer/dismiss', { offer_id: offer.offer_id }))).toMatchObject({ visible: true, offer_id: later.offer_id })
      expect(claims).toBe(2)
    } finally { s.deps.connectorOffers = originalOwner; await documents.close() }
  })

  it('retains a successful native claim through a document revision retry', async () => {
    const { ConnectorOffers } = await import('../tools/connectors.js')
    const { JsonDocuments } = await import('../sessions/storage/json-documents.js')
    const { RevisionConflict } = await import('../sessions/storage/backend.js')
    const documents = new JsonDocuments(s.deps.config.stateDir)
    const put = vi.spyOn(documents, 'put').mockRejectedValueOnce(new RevisionConflict('offer'))
    status = { available: true, eligible: true, guest_id: 'guest-c', due_in: 0, claimed: false }
    const before = claims
    try {
      const owner = new ConnectorOffers(documents)
      const offered = await owner.view('/synthetic/storage-retry', sidecar)
      expect(offered.visible).toBe(true)
      expect(claims).toBe(before + 1)
      expect(put).toHaveBeenCalledTimes(2)
      expect((await owner.view('/synthetic/storage-retry', sidecar)).offer_id).toBe(offered.offer_id)
    } finally { await documents.close() }
  })

  it('withdraws a signed-in, opted-out or replaced guest and never exposes another profile result', async () => {
    status = { ...status, available: true, eligible: false }
    expect((await json(await s.get('/api/connectors'))).sign_in_offer).toMatchObject({ visible: false, actions: [] })
    status = { ...status, guest_id: 'guest-b', eligible: true, due_in: null }
    expect((await json(await s.get('/api/connectors'))).sign_in_offer).toMatchObject({ visible: false })
    status = { ...status, guest_id: null, eligible: false }
    expect((await json(await s.get('/api/connectors'))).sign_in_offer).toMatchObject({ visible: false })
    status = { ...status, guest_id: 'guest-b', eligible: true, due_in: 0 }
    const own = (await json(await s.get('/api/connectors'))).sign_in_offer as Json
    status = { ...status, due_in: null }
    const other = await s.deps.connectorOffers.view('/synthetic/other-profile', sidecar)
    expect(other.visible).toBe(false)
    expect(other.offer_id).not.toBe(own.offer_id)
  })

  it.each(['no app', 'welcome trial', 'signed in', 'opted out', 'older Agent', 'unavailable'])('does not invent eligibility for %s', async (scenario) => {
    status = { available: !['older Agent', 'unavailable'].includes(scenario), eligible: false, guest_id: null, due_in: null, claimed: false }
    const before = claims
    expect((await json(await s.get('/api/connectors'))).sign_in_offer).toMatchObject({ due: false, visible: false, actions: [] })
    expect(claims).toBe(before)
  })
})
