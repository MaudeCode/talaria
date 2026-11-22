/**
 * TAL-1338: commands typed in a chat a native owner holds (its quick and plugin commands, Agent commands, `/refine`) run on that
 * owner through one fenced dispatch; Talaria never runs them itself or replays an outcome it could not confirm. A review's
 * summary arrives later on the owner's event stream and shows as one session notice.
 */
import type { GatewaySessionParams, GatewaySessionResult } from '@maudecode/talaria-web-contracts'
import type { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestServer } from '../test/harness.js'
import type { FakeSidecar } from '../sidecar/fake.js'
import type { StreamFrame } from '../sidecar/client.js'
import { CANONICAL_READ_ONLY_REASON } from './state-db.js'
import { admission, attached, bootOwnerAttachment, fixture, ownerHelpers, sid, snapshot } from '../test/gateway-owner.js'

/** The exchange the App adopts unchanged: the exec response, its refusals and the review summary's notice. */
const shared = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/web-native-commands.json', import.meta.url), 'utf8')) as {
  exec_response: { output: string }; refused_response: object; unknown_response: object; review_summary_event: { payload: { text: string } }; review_notice: { level: string; text: string }
}

describe('native owner commands (TAL-1338)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  let dispatch: Partial<GatewaySessionResult>
  beforeEach(async () => {
    ({ s, db, sidecar } = await bootOwnerAttachment())
    dispatch = { command_result: { kind: 'output', output: shared.exec_response.output } }
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'command_dispatch') return { ...attached(snapshot()), snapshot: null, ...dispatch }
      if (params.action === 'command_catalog') return { ...attached(snapshot()), snapshot: null, quick_commands: [{ name: 'deploy', description: 'exec: ./deploy.sh' }] }
      return attached(snapshot())
    })
    sidecar.respond('commands.registry', () => ({ commands: [{ name: 'refine', description: 'Review this conversation', category: 'Tools', aliases: [], args_hint: '[focus]', subcommands: [], cli_only: false, gateway_only: false, exec: false, prompt: null }] }))
  })
  afterEach(async () => { db.close(); await s.close() })
  const { post } = ownerHelpers(() => ({ s, sidecar }))
  const actions = (action: string) => sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action === action).map((c) => c.params as GatewaySessionParams)
  const exec = async (command: string) => { const r = await post('/api/commands/exec', { command, session_id: sid }); return { status: r.status, body: await r.json() as { output?: string; error?: string } } }

  it.each([['/refine keep deploy steps', 'refine', 'keep deploy steps'], ['/deploy now', 'deploy', 'now']])('runs %s once on the owner of the chat, never locally', async (typed, name, arg) => {
    expect(await exec(typed)).toEqual({ status: 200, body: shared.exec_response })
    expect(actions('command_dispatch')).toEqual([{ action: 'command_dispatch', name, arg, authority_epoch: 1, replay_epoch: 'owner-epoch', session_id: sid, profile_home: s.deps.profileHome('default') }])
    expect(sidecar.calls.filter((c) => ['chat.refine', 'commands.exec', 'chat.start'].includes(c.method))).toEqual([])
  })

  const refused = (error: string) => ({ error, code: 'owner_command_refused' })
  it.each([
    [{ state: 'refused', reason: 'unsupported_command' }, shared.refused_response],
    [{ state: 'refused', reason: 'permission_denied' }, refused('The owning Agent denied this command.')],
    [{ state: 'refused', reason: 'owner_changed' }, refused('The owning Agent changed. Run the command again.')],
    [{ state: 'attached', command_result: { kind: 'prompt' } }, refused('/deploy starts a turn on its owning Agent; send it as a message.')],
    [{ state: 'unavailable', reason: 'command_outcome_unknown' }, shared.unknown_response],
    [{ state: 'unavailable', reason: 'owner_connection_lost' }, shared.unknown_response],
  ] as const)('reports the owner verdict %o without running the command again', async (verdict, body) => {
    dispatch = { ...verdict, command_result: 'command_result' in verdict ? verdict.command_result : undefined, reason: 'reason' in verdict ? verdict.reason : null }
    expect(await exec('/deploy')).toEqual({ status: 409, body })
    expect(actions('command_dispatch')).toHaveLength(1)
    expect(sidecar.calls.filter((c) => c.method === 'commands.exec' || c.method === 'chat.refine')).toEqual([])
  })

  it('refuses before dispatch when the owner now answers for another session', async () => {
    sidecar.respond('gateway.session', () => attached(snapshot({ session_id: fixture.sessions.tui! })))
    expect((await exec('/refine')).status).toBe(409)
    expect(actions('command_dispatch')).toEqual([])
  })

  it('refuses an argument the owner dispatch cannot carry before reading the owner', async () => {
    expect((await exec(`/deploy ${'x'.repeat(8193)}`)).status).toBe(400)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session')).toEqual([])
  })

  it("lists and classifies the owner's quick commands only for its chat, reading them once per window", async () => {
    const list = async (query: string) => (await (await s.get(`/api/commands?${query}`)).json() as { commands: { name: string; exec: boolean; clients: string[] }[] }).commands
    expect((await list(`session_id=${sid}`)).find((c) => c.name === 'deploy')).toMatchObject({ exec: true, clients: ['web', 'ios'], category: 'User commands' })
    expect((await list(`prefix=dep&client=web&session_id=${sid}`)).map((c) => c.name)).toEqual(['deploy'])
    expect((await list('prefix=dep&client=web')).map((c) => c.name)).toEqual([])
    const classify = async (body: object) => (await post('/api/commands/classify', body)).json()
    expect(await classify({ text: '/deploy now', session_id: sid })).toEqual({ kind: 'exec', name: 'deploy', args: 'now' })
    expect(await classify({ text: '/deploy now' })).toEqual({ kind: 'text' })
    expect(actions('command_catalog')).toHaveLength(1)
  })
})

describe('native quick commands for a login without server-owner authority (TAL-1338)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  let catalog: Partial<GatewaySessionResult>
  let bound: Record<string, string>
  beforeEach(async () => {
    ({ s, db, sidecar } = await bootOwnerAttachment({ env: { TALARIA_WEB_TRUSTED_AUTH_HEADER: 'X-Remote-User', TALARIA_WEB_GROUP_PROFILE_MAP: '{}' } }))
    bound = { cookie: `${s.deps.auth.cookieName()}=${s.deps.auth.createSession({ authType: 'trusted', username: 'scoped-user', boundProfile: 'default' })}`, 'X-Remote-User': 'scoped-user', 'content-type': 'application/json' }
    catalog = { quick_commands: [{ name: 'deploy_app', description: 'exec: ./deploy.sh' }] }
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'command_dispatch') return { ...attached(snapshot()), snapshot: null, command_result: { kind: 'output', output: 'owner output' } }
      if (params.action === 'command_catalog') return { ...attached(snapshot()), snapshot: null, ...catalog }
      return attached(snapshot())
    })
    sidecar.respond('commands.registry', () => ({ commands: [] }))
  })
  afterEach(async () => { db.close(); await s.close() })
  const dispatched = () => sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action === 'command_dispatch').map((c) => (c.params as GatewaySessionParams).name)
  const exec = async (command: string) => (await s.get('/api/commands/exec', { method: 'POST', headers: bound, body: JSON.stringify({ command, session_id: sid }) })).status

  it('lists the quick command for no client and runs nothing that spells it, while other commands still reach the owner', async () => {
    const commands = (await (await s.get(`/api/commands?session_id=${sid}`, { headers: bound })).json() as { commands: { name: string }[] }).commands
    expect(commands.find((c) => c.name === 'deploy_app')).toMatchObject({ clients: [], unsupported_message: 'Only the server owner can run quick commands.' })
    expect(await (await s.get('/api/commands/classify', { method: 'POST', headers: bound, body: JSON.stringify({ text: '/deploy_app', session_id: sid }) })).json())
      .toEqual({ kind: 'unsupported', name: 'deploy_app', message: 'Only the server owner can run quick commands.' })
    expect([await exec('/deploy_app'), await exec('/Deploy-App now')]).toEqual([403, 403])
    expect(await exec('/refine')).toBe(200)
    expect(dispatched()).toEqual(['refine'])
  })

  it('runs nothing while the owner cannot list its quick commands', async () => {
    catalog = { state: 'unavailable', reason: 'owner_connection_lost', quick_commands: undefined }
    expect(await exec('/refine')).toBe(503)
    expect(dispatched()).toEqual([])
  })
})

describe('native review summaries (TAL-1338)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  beforeEach(async () => { ({ s, db, sidecar } = await bootOwnerAttachment()) })
  afterEach(async () => { db.close(); await s.close() })

  it('shows the latest summary once as a notice, after its command returned, with no turn', async () => {
    let emit!: (frame: Omit<StreamFrame, 'seq'>) => void
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return attached(snapshot())
      emit = send
      send({ event: 'snapshot', data: attached(snapshot()) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snapshot())) }, { once: true }) })
    })
    const controller = new AbortController()
    const lease = await s.deps.sessions.owner!.observe(sid, 'default', controller.signal)
    const notices = async () => (await s.deps.sessions.owner!.project({ session_id: sid, read_only_reason: CANONICAL_READ_ONLY_REASON })).notices as { text: string }[]
    const summary = (seq: number, text: string) => { emit({ event: 'event', data: { type: 'review.summary', session_id: sid, replay_epoch: 'owner-epoch', seq, payload: { text } } }) }
    try {
      await vi.waitFor(() => { expect(emit).toBeDefined() })
      summary(5, '')
      expect(await notices()).toEqual([])
      summary(6, shared.review_summary_event.payload.text)
      summary(6, 'duplicate replay')
      summary(5, 'late')
      expect(await notices()).toEqual([expect.objectContaining(shared.review_notice)])
      summary(7, '💾 Skill patched')
      expect((await notices()).map((n) => n.text)).toEqual(['💾 Skill patched'])
      expect(s.deps.registry.activeRunStreamForSession(sid)).toBeNull()
    } finally { controller.abort(); lease?.release(); await lease?.ended }
  })

  it("shows a running turn's summary as notices, never as the turn's text", async () => {
    const { observeOwner } = ownerHelpers(() => ({ s, sidecar }))
    const owner = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    await vi.waitFor(() => { expect(owner.attached).toBe(true) })
    owner.event('review.summary', { text: '💾 Memory updated' }, 1, { seq: 5 })
    owner.finish()
    const frames = await owner.read
    expect(frames.filter((f) => f.event === 'notices').map((f) => (f.data as { notices: { text: string }[] }).notices.map((n) => n.text))).toContainEqual(['💾 Memory updated'])
    const turn = frames.flatMap((f) => f.event === 'token' ? [f.data] : f.event === 'done' ? [(f.data as { session: { messages: unknown[] } }).session.messages] : [])
    expect(turn.length).toBeGreaterThan(0)
    expect(JSON.stringify(turn)).not.toContain('Memory updated')
  })
})
