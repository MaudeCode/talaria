import { afterEach, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import type { OutboundDraft } from '@maudecode/talaria-web-contracts'
import { SidecarError } from '../sidecar/client.js'

let server: TestServer | undefined
afterEach(async () => { await server?.close() })

it('TAL-1365: resolves an outbound draft through its session tool result, never through a transcript directive', async () => {
  server = await bootTestServer({ sidecar: new FakeSidecar() })
  const session = await server.deps.sessionStore.newSession()
  session.messages = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'draft-tool', type: 'function', function: { name: 'draft_card', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'draft-tool', content: JSON.stringify({ draft_id: 'd_1234abcd', version: 1, card: '::draft-card{id="d_1234abcd" v="1"}' }) },
  ]
  await server.deps.sessionStore.save(session)
  const query = new URLSearchParams({ session_id: session.session_id, tool_call_id: 'draft-tool', draft_id: 'd_1234abcd', card: '1' })
  const response = await server.get(`/api/session/outbound-draft?${query.toString()}`)
  expect(response.status, 'A tool-backed draft has a typed backend review boundary, even when its producer is unavailable').toBe(200)
  expect(await response.json()).toEqual({ draft: null })
})

async function backend() {
  const sidecar = new FakeSidecar()
  server = await bootTestServer({ sidecar })
  const session = await server.deps.sessionStore.newSession()
  const ref = { draft_id: 'd_1234abcd', card: 1 }
  session.messages = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'draft-tool', type: 'function', function: { name: 'draft_card', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'draft-tool', content: JSON.stringify({ ...ref, version: 1, card: '::draft-card{id="d_1234abcd" v="1"}' }) },
  ]
  await server.deps.sessionStore.save(session)
  let draft: OutboundDraft = { ...ref, producer: 'draft-cards', producer_revision: 'reviewed-pin', kind: 'email', platform: '', version: 1, revision: 'raw-content-revision', fields: { from: '', to: ['recipient@example.invalid'], cc: [], bcc: [], subject: 'Review', body: 'Reviewed content' }, state: 'draft', can_edit: true, can_approve: true, masked: false }
  sidecar.respond('drafts.review', (params) => {
    expect(params.profile_home).toBe(server!.deps.profileHome('default'))
    if (params.action !== 'read') {
      if (params.version !== draft.version || params.revision !== draft.revision) throw new SidecarError('changed', { condition: 'outbound_draft_conflict' })
      if (params.action === 'approve') draft = { ...draft, state: 'approved', can_approve: false, revision: 'approved' }
      else draft = { ...draft, version: 2, revision: 'edited', fields: params.fields! }
    }
    return { draft }
  })
  const input = { session_id: session.session_id, tool_call_id: 'draft-tool', ...ref }
  const read = (extra = {}) => server!.get(`/api/session/outbound-draft?${new URLSearchParams({ ...input, card: '1', ...extra }).toString()}`)
  const act = (action: string, version = 1, revision = 'raw-content-revision', extra = {}) => server!.get('/api/session/outbound-draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, action, version, revision, ...extra }) })
  return { sidecar, session, input, read, act, draft: () => draft, set: (patch: Partial<OutboundDraft>) => { draft = { ...draft, ...patch } } }
}

it('shows backend content and binds edit/approve to exactly that version without sending', async () => {
  const b = await backend()
  expect(await (await b.read()).json()).toEqual({ draft: b.draft() })
  const edited = await b.act('edit', 1, 'raw-content-revision', { fields: { ...b.draft().fields, body: 'Changed content' } })
  expect(edited.status).toBe(200)
  expect(await edited.json()).toMatchObject({ draft: { version: 2, fields: { body: 'Changed content' } } })
  expect((await b.act('approve')).status).toBe(409)
  expect((await b.act('approve', 2, 'edited')).status).toBe(200)
  expect((await b.act('approve', 2, 'edited')).status).toBe(409)
  expect(b.sidecar.calls.filter((c) => c.method === 'drafts.review' && (c.params as { action: string }).action === 'approve')).toHaveLength(1)
  expect(b.sidecar.calls.some((c) => c.method === 'chat.start' || c.method === 'approval.respond')).toBe(false)
})

it('masks secrets and refuses approval or overwriting concealed content even for a crafted client', async () => {
  const b = await backend()
  b.set({ fields: { ...b.draft().fields, body: 'password=synthetic-password' } })
  const response = await b.read()
  const body = await response.text()
  expect(body).not.toContain('synthetic-password')
  expect(JSON.parse(body)).toMatchObject({ draft: { masked: true, can_approve: false, can_edit: false } })
  expect((await b.act('approve')).status).toBe(409)
  expect((await b.act('edit', 1, 'raw-content-revision', { fields: b.draft().fields })).status).toBe(409)
})

it('refuses transcript-only, wrong-call, foreign-profile and replaced producer references before a write', async () => {
  const b = await backend()
  expect((await b.read({ tool_call_id: 'made-up' })).status).toBe(404)
  expect((await b.read({ draft_id: 'd_ffffffff' })).status).toBe(404)
  b.session.messages = [{ role: 'assistant', content: '::draft-card{id="d_1234abcd" v="1"}' }]
  await server!.deps.sessionStore.save(b.session)
  expect((await b.read()).status).toBe(404)
  b.session.profile = 'foreign'
  await server!.deps.sessionStore.save(b.session)
  expect((await b.act('approve')).status).toBe(404)
  expect(b.sidecar.calls.some((c) => c.method === 'drafts.review')).toBe(false)
})

it('reconciles a lost acknowledgment by reading confirmed state without repeating approval', async () => {
  const b = await backend()
  b.sidecar.respond('drafts.review', (params) => {
    if (params.action === 'approve') { b.set({ state: 'approved', can_approve: false }); throw new Error('lost acknowledgment') }
    return { draft: b.draft() }
  })
  expect((await b.act('approve')).status).toBe(503)
  expect(await (await b.read()).json()).toMatchObject({ draft: { state: 'approved', can_approve: false } })
  expect(b.sidecar.calls.filter((c) => c.method === 'drafts.review' && (c.params as { action: string }).action === 'approve')).toHaveLength(1)
})

it('keeps both drafts reviewable and approves the right artifact when a provider reuses a tool-call ID', async () => {
  const b = await backend()
  const older = b.draft()
  const newer: OutboundDraft = { ...older, draft_id: 'd_abcdef12', revision: 'newer-artifact', fields: { ...older.fields, body: 'A different draft' } }
  b.session.messages.push(
    { role: 'assistant', content: '', tool_calls: [{ id: 'draft-tool', type: 'function', function: { name: 'draft_card', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'draft-tool', content: JSON.stringify({ draft_id: newer.draft_id, version: 1, card: `::draft-card{id="${newer.draft_id}" v="1"}` }) },
  )
  await server!.deps.sessionStore.save(b.session)
  const approved: string[] = []
  b.sidecar.respond('drafts.review', (params) => {
    const draft = params.draft_id === older.draft_id ? older : newer
    if (params.action === 'approve') approved.push(params.draft_id)
    return { draft }
  })
  expect((await b.read()).status, 'The newer call with the same ID must not hide the older artifact').toBe(200)
  expect(await (await b.read({ draft_id: newer.draft_id })).json()).toEqual({ draft: newer })
  expect((await b.act('approve')).status).toBe(200)
  expect((await b.act('approve', newer.version, newer.revision, { draft_id: newer.draft_id })).status).toBe(200)
  expect(approved).toEqual([older.draft_id, newer.draft_id])
})
