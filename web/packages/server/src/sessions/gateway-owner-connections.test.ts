import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorOperationViewSchema, SessionEnvelopeSchema, type ConnectorOperationSnapshot, type ConnectorOperationView, type GatewaySessionResult, type GatewaySnapshot, type SidecarParams } from '@maudecode/talaria-web-contracts'
import type { DatabaseSync } from 'node:sqlite'
import type { TestServer } from '../test/harness.js'
import type { FakeSidecar } from '../sidecar/fake.js'
import { admission, attached, bootOwnerAttachment, ownerHelpers, sid, snapshot } from '../test/gateway-owner.js'

const shared = (JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/connectors.json', import.meta.url), 'utf8')) as { native_connection: { pending_connection: ConnectorOperationSnapshot; view: ConnectorOperationView } }).native_connection
const pending = shared.pending_connection
const opUrl = (op = pending.op_id, epoch: number | string = 1, session = sid) => `/api/connectors/operations/${op}?session_id=${session}&authority_epoch=${epoch}`
type Params = SidecarParams<'gateway.session'>
type Reply = GatewaySessionResult | Promise<GatewaySessionResult>
const bare = (extra: Partial<GatewaySessionResult>): GatewaySessionResult => ({ state: 'attached', reason: null, snapshot: null, receipt: null, ...extra })
const refused = (reason: string): GatewaySessionResult => ({ state: 'refused', reason, snapshot: null, receipt: null })
/** Every file the server persisted: journals, documents, the state database. */
const persistedFiles = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((name) => join(dir, name)).filter((path) => statSync(path).isFile()).map((path) => readFileSync(path, 'latin1'))
const lost: GatewaySessionResult = { state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null }

describe('canonical owner connection operations (TAL-1317)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  beforeEach(async () => { ({ s, db, sidecar } = await bootOwnerAttachment()) })
  afterEach(async () => { db.close(); await s.close() })
  const { post, observeOwner } = ownerHelpers(() => ({ s, sidecar }))
  const running = (extra: Partial<GatewaySnapshot> = {}) => snapshot({ running: true, pending: [admission()], pending_connection: pending, ...extra })
  const detail = async () => SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json()).session
  const owned = () => sidecar.calls.filter((call) => call.method === 'gateway.session').map((call) => call.params as Params)
  const connectionCalls = () => owned().filter((params) => params.action.startsWith('connection_'))

  /** The owner's connection verbs, answered per test. Everything else stays the synthetic observation. */
  const ownerAnswers = (answer: (params: Params) => Reply | undefined) => {
    const original = sidecar.responderFor('gateway.session')!
    sidecar.respond('gateway.session', (params, send, opts) => answer(params) ?? original(params, send, opts))
  }
  const openOwner = () => {
    let op: ConnectorOperationSnapshot | null = pending
    ownerAnswers((params) => {
      if (params.action === 'connection_status') return op && params.op_id === op.op_id ? bare({ connection: op }) : refused('UNKNOWN_OPERATION')
      return undefined
    })
    return { set: (next: ConnectorOperationSnapshot | null) => { op = next } }
  }

  it('restores the pending operation on attach and streams one view that live events update', async () => {
    const watch = await observeOwner(running())
    expect((await detail()).owner_attachment?.connection).toEqual(shared.view)
    // Later owner frames do not repeat the opening tool call; the view keeps it.
    const after = { ...pending, seq: 4, tool_call_id: null, targets: pending.targets.map((t) => t.name === 'gmail' ? { ...t, state: 'connected' as const, connect_url: null } : t) }
    watch.event('connection.update', after, 1, { seq: 5 })
    // A replayed or foreign frame never moves the view.
    for (const stamps of [{ seq: 5 }, { seq: 6, session_id: 'other' }, { seq: 6, replay_epoch: 'obsolete' }, { seq: 6, authority_epoch: 9 }]) watch.event('connection.update', { ...pending, seq: 9 }, 1, stamps)
    watch.event('connection.update', { ...after, seq: 3 }, 1, { seq: 7 })
    watch.event('connection.update', { ...after, seq: 5, settled: true }, 1, { seq: 8 })
    watch.finish()
    const cards = (await watch.read).filter((frame) => frame.event === 'connect_card').map((frame) => ConnectorOperationViewSchema.parse(frame.data))
    expect(cards.map((card) => [card.op_id, card.settled, card.targets[0]!.state])).toEqual([['op-native', false, 'initiated'], ['op-native', false, 'connected'], ['op-native', true, 'connected']])
    expect(cards[0]).toEqual(shared.view)
    expect(cards[1]!.tool_call_id).toBe('call-native')
    expect(cards.at(-1)).toMatchObject({ outcome: 'not_connected', can_continue: false, can_wake: false })
    expect(sidecar.calls.some((call) => call.method === 'chat.start' || call.method === 'connectors.operation')).toBe(false)
  })

  it('restores the current view from a reconnect snapshot and settles a card the snapshot no longer holds', async () => {
    const watch = await observeOwner(running())
    watch.snapshot({ pending_connection: { ...pending, seq: 6, targets: pending.targets.slice(0, 1) } }, true)
    watch.snapshot({ pending_connection: null }, true)
    watch.finish()
    const cards = (await watch.read).filter((frame) => frame.event === 'connect_card').map((frame) => ConnectorOperationViewSchema.parse(frame.data))
    expect(cards.map((card) => [card.settled, card.targets.length])).toEqual([[false, 5], [false, 1], [true, 1]])
  })

  it('replaces the view when the owner opens another operation, and never revives a settled one', async () => {
    const watch = await observeOwner(running())
    const next = { ...pending, op_id: 'op-next', seq: 1 }
    watch.event('connection.request', next, 1, { seq: 5 })
    watch.event('connection.update', { ...pending, seq: 9, settled: true }, 1, { seq: 6 })
    await vi.waitFor(async () => { expect((await detail()).owner_attachment?.connection?.op_id).toBe('op-native') })
    watch.finish()
    const cards = (await watch.read).filter((frame) => frame.event === 'connect_card').map((frame) => ConnectorOperationViewSchema.parse(frame.data))
    expect(cards.map((card) => [card.op_id, card.settled])).toEqual([['op-native', false], ['op-next', false]])
  })

  it('binds the view to a replacement owner and drops the old owner\'s late frames', async () => {
    const watch = await observeOwner(running())
    const replacement = { ...pending, op_id: 'op-replacement', seq: 1 }
    watch.snapshot({ authority_epoch: 2, replay_epoch: 'new-owner', execution_generation: 1, last_sequence: 1, pending_connection: replacement }, true)
    watch.event('connection.update', { ...pending, seq: 9 }, 1, { seq: 50, authority_epoch: 1, replay_epoch: 'owner-epoch' })
    watch.finish()
    const cards = (await watch.read).filter((frame) => frame.event === 'connect_card').map((frame) => ConnectorOperationViewSchema.parse(frame.data))
    expect(cards.map((card) => [card.op_id, card.owner?.authority_epoch])).toEqual([['op-native', 1], ['op-replacement', 2]])
  })

  it('closes the card when a cancelled turn settles the operation', async () => {
    const watch = await observeOwner(running())
    watch.event('connection.update', { ...pending, seq: 4, settled: true }, 1, { seq: 5 })
    watch.finish(1, 'interrupted')
    const frames = await watch.read
    expect(ConnectorOperationViewSchema.parse(frames.findLast((frame) => frame.event === 'connect_card')!.data)).toMatchObject({ settled: true, can_continue: false })
    expect(frames.some((frame) => frame.event === 'cancel')).toBe(true)
  })

  it('reads status and wakes through that exact owner, and a read starts nothing', async () => {
    openOwner()
    const read = await s.get(opUrl())
    expect(await read.json()).toEqual(shared.view)
    expect(connectionCalls()).toEqual([expect.objectContaining({ action: 'connection_status', session_id: sid, op_id: 'op-native', authority_epoch: 1, profile_home: s.deps.profileHome('default') })])
    expect(sidecar.calls.some((call) => ['connectors.operation', 'connectors.connect', 'connectors.respond', 'chat.start'].includes(call.method))).toBe(false)
    ownerAnswers((params) => params.action === 'connection_wake' ? bare({}) : undefined)
    const woke = await post(`/api/connectors/operations/op-native`, { action: 'wake', session_id: sid, authority_epoch: 1 })
    expect(woke.status).toBe(200)
    expect(connectionCalls().map((params) => params.action)).toEqual(['connection_status', 'connection_status', 'connection_wake', 'connection_status'])
  })

  it('answers each permitted move through the owner and keeps row moves and Continue exclusive', async () => {
    openOwner()
    const answers: unknown[] = []
    ownerAnswers((params) => {
      if (params.action === 'connection_respond') { answers.push(params.connection_answer); return bare({ connection_settled: false }) }
      if (params.action === 'connection_retry') { answers.push(params.connector); return bare({ connection: pending }) }
      return undefined
    })
    const move = (body: Record<string, unknown>) => post('/api/connectors/operations/op-native', { session_id: sid, authority_epoch: 1, ...body })
    expect((await move({ action: 'skip', target: 'gmail' })).status).toBe(200)
    expect((await move({ action: 'retry', target: 'notion' })).status).toBe(200)
    expect((await move({ action: 'approve', target: 'linear', env: { LINEAR_API_KEY: 'synthetic-secret-value', NOT_ASKED: 'dropped' } })).status).toBe(200)
    expect(answers).toEqual([
      { targets: [{ name: 'gmail', status: 'skipped' }] },
      'notion',
      { targets: [{ name: 'linear', status: 'approved', env: { LINEAR_API_KEY: 'synthetic-secret-value' } }] },
    ])
    answers.length = 0
    ownerAnswers((params) => params.action === 'connection_respond' ? (answers.push(params.connection_answer), bare({ connection_settled: true })) : undefined)
    const settled = await (await move({ action: 'continue' })).json() as ConnectorOperationView
    expect(answers).toEqual([{ settled_by: 'continue' }])
    expect(settled).toMatchObject({ op_id: 'op-native', settled: true, outcome: 'not_connected', can_continue: false, can_wake: false })
    expect(settled.targets.every((target) => target.actions.length === 0 && target.connect_url === null && target.env_fields.length === 0)).toBe(true)
    // A move the operation does not offer now, and Continue mixed with a row, never reach the owner.
    answers.length = 0
    for (const body of [{ action: 'skip', target: 'slack' }, { action: 'retry', target: 'gmail' }, { action: 'approve', target: 'notion' }, { action: 'skip', target: 'absent' }, { action: 'continue', target: 'gmail' }, { action: 'continue', env: { LINEAR_API_KEY: 'x' } }]) {
      const refusal = await move(body)
      expect(refusal.status).toBe(409)
      expect(await refusal.json()).toMatchObject({ code: 'operation_refused' })
    }
    expect(answers).toEqual([])
  })

  it('never lets client fields reach the owner beyond the closed move', async () => {
    openOwner()
    ownerAnswers((params) => params.action === 'connection_respond' ? bare({ connection_settled: false }) : undefined)
    await post('/api/connectors/operations/op-native', { session_id: sid, authority_epoch: 1, action: 'skip', target: 'gmail', owner: { type: 'account' }, profile_home: '/foreign', connection_id: 'other', alias: 'other', settled_by: 'continue' })
    const call = connectionCalls().find((params) => params.action === 'connection_respond')!
    expect(call).toEqual({ action: 'connection_respond', session_id: sid, profile_home: s.deps.profileHome('default'), op_id: 'op-native', authority_epoch: 1, connection_answer: { targets: [{ name: 'gmail', status: 'skipped' }] } })
  })

  it('refuses a stale, foreign or replaced operation and keeps managed refusals visible', async () => {
    const owner = openOwner()
    for (const url of [opUrl('op-other'), opUrl('op-native', 2)]) {
      ownerAnswers((params) => params.action === 'connection_status' && params.authority_epoch === 2 ? refused('owner_changed') : undefined)
      const gone = await s.get(url)
      expect(gone.status).toBe(404)
      expect(await gone.json()).toMatchObject({ code: 'operation_not_found' })
    }
    expect((await s.get(opUrl('op-native', 1, 'not-a-canonical-session'))).status).toBe(403)
    for (const [reason, status, code] of [['CONNECTORS_UNAVAILABLE', 404, 'connectors_unavailable'], ['NEEDS_NOUS_AUTH', 403, 'connectors_sign_in'], ['FORBIDDEN_SCOPE', 403, 'connectors_forbidden'], ['ORG_ACCESS_DENIED', 403, 'connectors_forbidden'], ['REISSUE_REFUSED', 409, 'operation_refused'], ['LINK_STILL_VALID', 409, 'operation_refused'], ['CONNECTOR_REQUEST_FAILED', 502, 'connectors_failed'], ['raw/unexpected detail', 409, 'operation_refused']] as const) {
      ownerAnswers((params) => params.action === 'connection_retry' ? refused(reason) : undefined)
      const answer = await post('/api/connectors/operations/op-native', { session_id: sid, authority_epoch: 1, action: 'retry', target: 'notion' })
      expect(answer.status).toBe(status)
      const body = await answer.json() as { code: string; error: string }
      expect(body.code).toBe(code)
      expect(body.error).not.toContain('raw/unexpected')
    }
    owner.set(null)
    const settledAway = await post('/api/connectors/operations/op-native', { session_id: sid, authority_epoch: 1, action: 'skip', target: 'gmail' })
    expect(settledAway.status).toBe(404)
  })

  it('reconciles a lost acknowledgment by reading the same operation and never replays the move', async () => {
    const owner = openOwner()
    const moved = { ...pending, seq: 5, targets: pending.targets.map((t) => t.name === 'gmail' ? { ...t, state: 'skipped' as const, connect_url: null } : t) }
    let sent = 0
    ownerAnswers((params) => {
      if (params.action !== 'connection_respond') return undefined
      sent++
      owner.set(moved)
      return lost
    })
    const body = { session_id: sid, authority_epoch: 1, action: 'skip', target: 'gmail' }
    const landed = await (await post('/api/connectors/operations/op-native', body)).json() as ConnectorOperationView
    expect(landed.targets.find((t) => t.name === 'gmail')?.state).toBe('skipped')
    expect(sent).toBe(1)

    // The operation settled and closed while the acknowledgment was lost.
    sent = 0
    owner.set(pending)
    ownerAnswers((params) => {
      if (params.action !== 'connection_respond') return undefined
      sent++
      owner.set(null)
      return lost
    })
    const closed = await (await post('/api/connectors/operations/op-native', body)).json() as ConnectorOperationView
    expect(closed.settled).toBe(true)
    expect(sent).toBe(1)

    // Neither the move nor its read answered: the outcome stays unknown and nothing is resent.
    sent = 0
    owner.set(pending)
    let reads = 0
    ownerAnswers((params) => {
      if (params.action === 'connection_respond') { sent++; return lost }
      if (params.action === 'connection_status' && ++reads > 1) return lost
      return undefined
    })
    const unknown = await post('/api/connectors/operations/op-native', body)
    expect(unknown.status).toBe(503)
    expect(await unknown.json()).toMatchObject({ outcome_unknown: true })
    expect(sent).toBe(1)
  })

  it('keeps secret values private and withholds links that are not valid https', async () => {
    const withheld = ['http://vendor.example.test/a', 'javascript:alert(1)', 'https://', 'https://exa mple.test/a', 'https://user:pw@vendor.example.test/a', 'not a url']
    const secret = 'synthetic-secret-value-0123456789'
    const raw: ConnectorOperationSnapshot = { ...pending, targets: [
      ...withheld.map((connect_url, index) => ({ name: `bad${index}`, kind: 'connector', state: 'initiated' as const, detail: '', connect_url, required_env: [] })),
      { name: 'leaky', kind: 'connector', state: 'failed' as const, detail: 'token=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', connect_url: null, required_env: [] },
      { name: 'linear', kind: 'mcp', state: 'pending' as const, detail: '', connect_url: null, required_env: [{ name: 'LINEAR_API_KEY', prompt: 'API key', required: true, secret: true }] },
    ] }
    const watch = await observeOwner(running({ pending_connection: raw }))
    const view = (await detail()).owner_attachment!.connection!
    expect(view.targets.slice(0, withheld.length).map((target) => target.connect_url)).toEqual(withheld.map(() => null))
    expect(view.targets.find((t) => t.name === 'leaky')!.detail).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789')
    expect(view.targets.find((t) => t.name === 'linear')!.env_fields).toEqual([{ name: 'LINEAR_API_KEY', label: 'API key', required: true, secret: true }])

    ownerAnswers((params) => {
      if (params.action === 'connection_status') return bare({ connection: raw })
      return params.action === 'connection_respond' ? bare({ connection_settled: false }) : undefined
    })
    const answered = await post('/api/connectors/operations/op-native', { session_id: sid, authority_epoch: 1, action: 'approve', target: 'linear', env: { LINEAR_API_KEY: secret } })
    expect(answered.status).toBe(200)
    const sentToOwner = connectionCalls().filter((params) => JSON.stringify(params).includes(secret))
    expect(sentToOwner.map((params) => params.action)).toEqual(['connection_respond'])
    watch.finish()
    for (const text of [JSON.stringify(await watch.read), await answered.text(), JSON.stringify(await detail()), ...persistedFiles(s.state)]) expect(text).not.toContain(secret)
  })

  it('keeps an authorization link whole under the default API redaction', async () => {
    const link = 'https://vendor.example.test/authorize?token=abcdefghijklmnopqrstuvwx&state=opaque-state'
    const raw = { ...pending, targets: [{ ...pending.targets[0]!, connect_url: link }] }
    const watch = await observeOwner(running({ pending_connection: raw }))
    expect((await detail()).owner_attachment?.connection?.targets[0]?.connect_url).toBe(link)
    watch.snapshot({ last_sequence: 6 }, true)
    watch.finish()
    const frames = await watch.read
    const card = frames.find((frame) => frame.event === 'connect_card')
    expect(ConnectorOperationViewSchema.parse(card!.data).targets[0]?.connect_url).toBe(link)
    const session = frames.find((frame) => frame.event === 'session_snapshot')?.data as { session: { owner_attachment: { connection: ConnectorOperationView } } }
    expect(session.session.owner_attachment.connection.targets[0]?.connect_url).toBe(link)
  })

  it('leaves direct connector operations on their own route', async () => {
    const direct = { op_id: 'op-direct', settled: false, owner: 'session' as const, tool_call_id: null, targets: [] }
    sidecar.respond('connectors.operation', () => direct)
    const read = await (await s.get('/api/connectors/operations/op-direct')).json() as ConnectorOperationView
    expect(read).toMatchObject({ op_id: 'op-direct' })
    expect(read).not.toHaveProperty('owner')
    expect(connectionCalls()).toEqual([])
  })

  it('omits the card for an older owner without the field', async () => {
    sidecar.respond('gateway.session', () => attached(snapshot()))
    expect((await detail()).owner_attachment?.connection ?? null).toBeNull()
  })
})
