import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
    expect(await json(await s.get('/api/connectors'))).toEqual({ available: false, connectors: [], policy_revision: null })
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
    ] }))
    const tools = await json(await s.get('/api/connectors/notion/tools'))
    expect(tools).toEqual(shared.tools)
    // Notion is off in the member rules, so none of its tool switches may write (the Agent refuses that rule).
    expect((tools.tools as Json[]).map((t) => [t.slug, t.enabled, t.locked, t.editable])).toEqual([['notion_read', true, false, false], ['notion_send', false, false, false], ['notion_delete', false, true, false], ['notion_purge', false, true, false]])

    // Rules another layer refuses to show leave the page read-only instead of failing it.
    sidecar.respond('connectors.policy.get', () => { throw new SidecarError('Select an organization', { condition: 'connectors_org_required' }) })
    const readOnly = await json(await s.get('/api/connectors'))
    expect(readOnly.policy_revision).toBeNull()
    expect((readOnly.connectors as Json[]).map((c) => [c.enabled, c.rules_editable])).toEqual([[true, false], [true, false]])
    for (const method of ['connectors.accounts', 'connectors.policy.get', 'connectors.tools'] as const) sidecar.respond(method, undefined)
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
    expect(started).toEqual({ op_id: 'op-page', settled: false, can_continue: false, tool_call_id: null, targets: [
      { name: 'gmail', title: 'Gmail', kind: 'connector', state: 'initiated', detail: '', connect_url: 'https://vendor.example.test/authorize/conn-1', actions: ['skip'], env_fields: [] },
    ] })
    sidecar.respond('connectors.operation', () => pageConnect('initiated'))
    // Continue belongs to a chat card; the page's operation refuses it before it reaches the Agent.
    const refused = await post(s, '/api/connectors/operations/op-page', { action: 'continue' })
    expect(refused.status).toBe(409)
    expect(sidecar.calls.some((c) => c.method === 'connectors.respond')).toBe(false)

    sidecar.respond('connectors.operation', () => pageConnect('connected', true))
    const done = await json(await s.get('/api/connectors/operations/op-page'))
    expect(done).toMatchObject({ settled: true, targets: [{ state: 'connected', connect_url: null, actions: [] }] })
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
    sidecar.respond('chat.start', async (params, emit) => {
      emit({ event: 'connection', data: card })
      await new Promise<void>((resolve) => { release = resolve })
      emit({ event: 'token', data: { text: 'continued' } })
      return { status: 'completed', messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'continued' }], final_response: 'continued', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }
    })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'connect gmail' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${str(start.stream_id)}`, (f) => f.event === 'connect_card')
    const shown = frames.at(-1)?.data as Json
    expect(shown).toEqual(shared.connect_card)
    expect(shown).toMatchObject({ op_id: 'op-chat', can_continue: true, tool_call_id: 'call-1' })
    expect((shown.targets as Json[]).map((t) => [t.name, t.title, t.actions, (t.env_fields as Json[]).length])).toEqual([['gmail', 'Gmail', ['skip'], 0], ['linear', 'Linear', ['approve', 'skip'], 1]])

    const continued = await json(await post(s, '/api/connectors/operations/op-chat', { action: 'continue' }))
    expect(continued.settled).toBe(true)
    await s.sse(`/api/chat/stream?stream_id=${str(start.stream_id)}&after_event_id=${str(start.stream_id)}:0`, (f) => f.event === 'stream_end')
    for (const method of ['connectors.operation', 'connectors.respond', 'chat.start'] as const) sidecar.respond(method, undefined)
  })
})
