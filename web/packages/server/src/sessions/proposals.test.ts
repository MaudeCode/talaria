import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIDECAR_SERVER_METHODS } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { Session } from './session.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { createStorage } from '../runtime.js'
import type { DocumentBackend } from './storage/backend.js'
import { toolOutcome } from './merge.js'

type Method = 'server.proposal_put' | 'server.proposal_read'
type Json = Record<string, unknown>
const fixtures = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/proposals.json'), 'utf8')) as Record<Method, { params: Json; result: Json }[]>
const CALLER = '20261109_090000_caller'
const completed = { status: 'completed', messages: [], final_response: 'ok', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] } as never
const FINDINGS = 'probe · community · 0123456789abcdef0123456789abcdef01234567\nhttps://github.com/example/probe\nInstalls disabled. No dependency, host capability or sidecar permission is granted.'
const ENTRY = { name: 'probe', title: 'Probe', description: 'Reads probes.', repo: 'https://github.com/example/probe', sha: '0123456789abcdef0123456789abcdef01234567', tier: 'community', category: 'tools', requirements: [], installed_key: null, installed_sha: null, can_install: true, refusal: null, can_update: false }

describe('proposals (TAL-1967)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let documents: DocumentBackend
  let clock = 1_794_100_000
  const configs = new Map<string, Json>()
  const installs: Json[] = []
  const jobs: Json[] = []
  const ask = async (method: Method, params: Json, caller = CALLER) => {
    const reply = await sidecar.serverRequest(method, { caller_session_id: caller, ...params })
    return 'error' in reply ? reply : { result: SIDECAR_SERVER_METHODS[method].result.parse(reply.result) }
  }
  const condition = (reply: unknown) => (reply as { error?: { data?: { condition?: string } } }).error?.data?.condition
  const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await s.get(path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } } : { headers }) })
    return { status: res.status, body: await res.json() as Json }
  }
  const propose = async (kind: string, payload: Json, caller = CALLER) => {
    const reply = await ask('server.proposal_put', { kind, payload, timeout_seconds: 600 }, caller) as { result?: { proposal_id: string } }
    return { reply, id: reply.result?.proposal_id ?? '' }
  }
  const show = async (id: string) => (await http('GET', `/api/proposals/${id}`)).body
  const approve = async (id: string, hash?: string) => http('POST', `/api/proposals/${id}/approve`, { payload_hash: hash ?? (await show(id)).payload_hash })
  const told = () => sidecar.calls.filter((call) => call.method === 'chat.start').map((call) => (call.params as { user_message: string }).user_message)
  const save = async (session_id: string, profile = 'default') => {
    const workspace = join(s.state, 'workspace')
    mkdirSync(workspace, { recursive: true })
    await s.deps.sessionStore.save(new Session({ session_id, title: session_id, profile, workspace, updated_at: clock, messages: [{ role: 'user', content: session_id, timestamp: clock }] }, { workspace, model: null }))
  }

  beforeEach(async () => {
    clock = 1_794_100_000
    configs.clear()
    installs.length = 0
    jobs.length = 0
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, now: () => clock, storage: async (config) => { const backend = await createStorage(config, () => clock); documents = backend.documents; return backend } })
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: existsSync(join(params.profile_home, 'config.yaml')), config: configs.get(params.profile_home) ?? {} }))
    sidecar.respond('config.set', (params) => { configs.set(params.profile_home, params.config); writeFileSync(join(params.profile_home, 'config.yaml'), `# ${String(Math.random())}\n`); return { ok: true as const, path: join(params.profile_home, 'config.yaml') } })
    sidecar.respond('plugins.catalog', () => ({ supported: true, entries: [ENTRY], total: 1, next_offset: null }))
    sidecar.respond('plugins.install', (params) => {
      installs.push(params)
      return params.consent_token ? { name: params.name, key: 'probe', status: 'installed', enabled: false } : { name: params.name, status: 'needs_consent', findings: FINDINGS, consent_token: `token-${String(installs.length)}` }
    })
    sidecar.respond('cron.create', (params) => { const job = { id: 'job-1', name: null, profile: null, toast_notifications: true, monitor: '', continuity: false, ...(params.job as Json), context_from: (params.job as Json).context_from ?? [] }; jobs.push(job); return { job } })
    sidecar.respond('chat.start', () => completed)
    await save(CALLER)
  })
  afterEach(async () => { await s.close() })

  it('records the server.proposal_* fixtures from the real handlers', async () => {
    // The fixtures name the proposal `pr_0a1b2c3d`; this run's random id stands in for it.
    let id = 'pr_0a1b2c3d'
    const asRun = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('pr_0a1b2c3d', id)) as T
    const [put] = fixtures['server.proposal_put']
    const reply = await ask('server.proposal_put', put!.params, String(put!.params.caller_session_id))
    id = (reply as { result: { proposal_id: string } }).result.proposal_id
    expect(reply).toEqual({ result: asRun(put!.result) })
    clock += 60
    expect((await http('POST', `/api/proposals/${id}/reject`)).status).toBe(200)
    const [read] = fixtures['server.proposal_read']
    expect(await ask('server.proposal_read', asRun(read!.params), String(read!.params.caller_session_id))).toEqual({ result: asRun(read!.result) })
  })

  it('installs a catalog plugin: the route previews on put, and approval previews again and confirms with the consent token', async () => {
    const { reply, id } = await propose('plugin_install', { catalog_id: 'probe', pin: '0123456' })
    expect(reply).toEqual({ result: { proposal_id: id, status: 'pending', url: `/session/${CALLER}`, kind: 'plugin_install', summary: 'Install plugin Probe' } })
    expect(installs).toEqual([{ profile_home: s.deps.profileHome('default'), name: 'probe' }])
    const card = await show(id)
    expect(card).toMatchObject({
      kind: 'plugin_install', payload: { catalog_id: 'probe', pin: ENTRY.sha }, status: 'pending', diff: [],
      fields: [{ label: 'Plugin', value: 'Probe (probe)' }, { label: 'Description', value: 'Reads probes.' }, { label: 'Repository', value: ENTRY.repo }, { label: 'Pin', value: ENTRY.sha }, { label: 'Tier', value: 'community' }],
      risk_notes: FINDINGS.split('\n'), actions: { can_approve: true, can_reject: true, reason: null }, expires_at: clock + 600,
    })
    expect(card).not.toHaveProperty('review')

    const approved = await approve(id)
    expect(approved).toMatchObject({ status: 200, body: { status: 'applied', outcome: { text: 'Installed probe, turned off until you enable it in Plugins.', error: null }, actions: { can_approve: false, reason: 'closed' } } })
    expect(installs.slice(1)).toEqual([{ profile_home: s.deps.profileHome('default'), name: 'probe' }, { profile_home: s.deps.profileHome('default'), name: 'probe', consent_token: 'token-2' }])
    await vi.waitFor(() => { expect(told()).toEqual([`Proposal ${id} (Install plugin Probe) was approved and applied: Installed probe, turned off until you enable it in Plugins. Call proposal_read with proposal_id ${id} for details.`]) })
  })

  it('fails a plugin approval, installing nothing, when the preview no longer matches what was reviewed', async () => {
    const { id } = await propose('plugin_install', { catalog_id: 'probe', pin: ENTRY.sha })
    sidecar.respond('plugins.install', (params) => { installs.push(params); return { name: params.name, status: 'needs_consent', findings: `${FINDINGS}\nPython dependencies, not approved: evil`, consent_token: 'later' } })
    const approved = await approve(id)
    expect(approved.body).toMatchObject({ status: 'failed', outcome: { text: null, error: 'The plugin changed since it was reviewed. Ask the agent for a new proposal.' } })
    expect(installs.filter((call) => call.consent_token)).toEqual([])
  })

  it('adds an MCP server through the MCP route, with env names but never values, and shows the config diff', async () => {
    writeFileSync(join(s.state, '.env'), 'NOTES_TOKEN=secret\n')
    const { id } = await propose('mcp_server', { name: 'notes', command: 'npx', args: ['-y', 'notes-mcp'], env_names: ['NOTES_TOKEN', 'NOTES_HOST'] })
    expect(await show(id)).toMatchObject({
      summary: 'Add MCP server notes', payload: { name: 'notes', url: null, command: 'npx', args: ['-y', 'notes-mcp'], env_names: ['NOTES_TOKEN', 'NOTES_HOST'] }, fields: [],
      diff: [
        { kind: 'addition', old_line: null, new_line: 1, text: '+command: npx' },
        { kind: 'addition', old_line: null, new_line: 2, text: '+args: ["-y","notes-mcp"]' },
        { kind: 'addition', old_line: null, new_line: 3, text: '+env: {"NOTES_TOKEN":"${NOTES_TOKEN}","NOTES_HOST":"${NOTES_HOST}"}' },
      ],
      risk_notes: ['Runs npx -y notes-mcp on this machine and gives the agent its tools.', 'Passes NOTES_TOKEN, NOTES_HOST from the profile\'s .env to it.', 'Not in the profile\'s .env yet: NOTES_HOST.'],
    })
    expect((await approve(id)).body).toMatchObject({ status: 'applied', outcome: { text: 'Saved MCP server notes to the profile\'s config.' } })
    expect((configs.get(s.state)?.mcp_servers as Json).notes).toEqual({ command: 'npx', args: ['-y', 'notes-mcp'], env: { NOTES_TOKEN: '${NOTES_TOKEN}', NOTES_HOST: '${NOTES_HOST}' } })
    expect(JSON.stringify(await show(id))).not.toContain('secret')
  })

  it('fails an MCP approval with the route\'s error and leaves config.yaml unchanged', async () => {
    configs.set(s.state, { mcp_servers: { notes: { url: 'https://old.example/mcp', enabled: false } } })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    const { id } = await propose('mcp_server', { name: 'notes', url: 'https://notes.example/mcp' })
    expect((await show(id)).diff).toEqual([
      { kind: 'deletion', old_line: 1, new_line: null, text: '-url: https://old.example/mcp' },
      { kind: 'addition', old_line: null, new_line: 1, text: '+url: https://notes.example/mcp' },
    ])
    sidecar.respond('config.set', () => { throw new Error('config.yaml is read-only') })
    const before = structuredClone(configs.get(s.state))
    const approved = await approve(id)
    expect(approved.body).toMatchObject({ status: 'failed', outcome: { text: null, error: expect.stringContaining('read-only') as unknown } })
    expect(configs.get(s.state)).toEqual(before)
    await vi.waitFor(() => { expect(told()).toEqual([expect.stringContaining(`Proposal ${id} (Change MCP server notes) was approved but failed:`)]) })
  })

  it('replaces an existing MCP server exactly as shown, masking its stored credentials and clearing what the proposal drops', async () => {
    configs.set(s.state, { mcp_servers: {
      notes: { command: 'old-notes', args: ['--verbose'], env: { API_TOKEN: 'plain-secret', HOST: '${HOST}' }, cwd: '/srv/notes', enabled: true },
      remote: { url: 'https://old.example/mcp', headers: { Authorization: 'Bearer header-secret' } },
    } })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    const command = await propose('mcp_server', { name: 'notes', command: 'npx' })
    const shown = await show(command.id)
    expect(shown.diff).toEqual([
      { kind: 'deletion', old_line: 1, new_line: null, text: '-command: old-notes' },
      { kind: 'addition', old_line: null, new_line: 1, text: '+command: npx' },
      { kind: 'context', old_line: 2, new_line: 2, text: ' cwd: /srv/notes' },
      { kind: 'deletion', old_line: 3, new_line: null, text: '-args: ["--verbose"]' },
      { kind: 'deletion', old_line: 4, new_line: null, text: '-env: {"API_TOKEN":"••••••","HOST":"${HOST}"}' },
    ])
    const remote = await propose('mcp_server', { name: 'remote', url: 'https://new.example/mcp' })
    for (const id of [command.id, remote.id]) {
      expect(JSON.stringify(await show(id))).not.toMatch(/plain-secret|header-secret/)
      expect(JSON.stringify(await ask('server.proposal_read', { proposal_id: id }))).not.toMatch(/plain-secret|header-secret/)
      expect((await approve(id)).body.status).toBe('applied')
    }
    // What the owner approved is what config.yaml holds: the dropped args, env and headers are gone.
    expect(configs.get(s.state)?.mcp_servers).toEqual({ notes: { command: 'npx', cwd: '/srv/notes', enabled: true }, remote: { url: 'https://new.example/mcp' } })
  })

  it('changes a setting through the settings route, showing its current and proposed value', async () => {
    const { id } = await propose('setting', { key: 'show_token_usage', value: true })
    expect(await show(id)).toMatchObject({ summary: 'Change setting show_token_usage', diff: [{ kind: 'deletion', text: '-show_token_usage: false' }, { kind: 'addition', text: '+show_token_usage: true' }], risk_notes: [] })
    expect((await approve(id)).body).toMatchObject({ status: 'applied', outcome: { text: 'Set show_token_usage to true.' } })
    expect((await http('GET', '/api/settings')).body.show_token_usage).toBe(true)
  })

  it('fails a setting the route refuses and leaves the settings unchanged', async () => {
    sidecar.respond('config.declares_key', () => ({ declared: false }))
    const before = (await http('GET', '/api/settings')).body
    const { id } = await propose('setting', { key: 'compression_prepare_ahead', value: true })
    expect((await show(id)).diff).toEqual([{ kind: 'deletion', old_line: 1, new_line: null, text: '-compression_prepare_ahead: null' }, { kind: 'addition', old_line: null, new_line: 1, text: '+compression_prepare_ahead: true' }])
    expect((await approve(id)).body).toMatchObject({ status: 'failed', outcome: { error: 'This Agent does not offer prepared compaction.' } })
    expect((await http('GET', '/api/settings')).body).toEqual(before)
  })

  it('schedules a task through the crons route', async () => {
    sidecar.respond('cron.list', () => ({ jobs: [{ id: 'job-0', name: 'Inbox sweep', prompt: 'Sweep.', schedule: 'every 1h', enabled: true, profile: 'default', toast_notifications: true, monitor: '', continuity: false }] as never[] }))
    const { id } = await propose('cron_job', { title: 'Morning digest', schedule: 'every day at 08:00', prompt: 'Summarize the inbox.', context_sources: ['job-0'] })
    expect(await show(id)).toMatchObject({ summary: 'Schedule task Morning digest', fields: [{ label: 'Title', value: 'Morning digest' }, { label: 'Schedule', value: 'every day at 08:00' }, { label: 'Prompt', value: 'Summarize the inbox.' }, { label: 'Reads output of', value: 'job-0' }] })
    expect((await approve(id)).body).toMatchObject({ status: 'applied', outcome: { text: 'Scheduled Morning digest (job-1).' } })
    expect(jobs).toEqual([expect.objectContaining({ name: 'Morning digest', schedule: 'every day at 08:00', prompt: 'Summarize the inbox.', context_from: ['job-0'] })])
  })

  it('rejects without applying, tells the session once, and the agent reads the status', async () => {
    const emitted = vi.spyOn(s.deps.channels, 'emit')
    const { id } = await propose('setting', { key: 'show_token_usage', value: true })
    expect(emitted).toHaveBeenLastCalledWith(CALLER, 'proposal', { session_id: CALLER, proposal_id: id, status: 'pending' }, 'default')
    expect((await http('POST', `/api/proposals/${id}/reject`)).body).toMatchObject({ status: 'rejected', outcome: { text: null, error: null }, decided_at: clock })
    expect(emitted).toHaveBeenLastCalledWith(CALLER, 'proposal', { session_id: CALLER, proposal_id: id, status: 'rejected' }, 'default')
    expect((await http('GET', '/api/settings')).body.show_token_usage).toBe(false)
    await vi.waitFor(() => { expect(told()).toEqual([`Proposal ${id} (Change setting show_token_usage) was rejected. Call proposal_read with proposal_id ${id} for details.`]) })
    expect(await ask('server.proposal_read', { proposal_id: id })).toMatchObject({ result: { proposal_id: id, status: 'rejected', outcome: { text: null, error: null } } })
    expect((await http('POST', `/api/proposals/${id}/approve`, { payload_hash: (await show(id)).payload_hash })).body).toMatchObject({ code: 'proposal_closed' })
  })

  it('refuses a stale hash, a second approval and an expired proposal by name, applying nothing', async () => {
    const { id } = await propose('setting', { key: 'show_token_usage', value: true })
    expect(await approve(id, 'not-the-reviewed-hash')).toEqual({ status: 409, body: { error: 'This proposal is not the version that was reviewed.', code: 'payload_changed' } })
    expect((await show(id)).status).toBe('pending')
    expect((await approve(id)).body.status).toBe('applied')
    expect(await approve(id)).toMatchObject({ status: 409, body: { code: 'proposal_closed' } })
    expect(told()).toHaveLength(1)

    const late = await propose('setting', { key: 'show_tps', value: true })
    clock += 600
    expect(await show(late.id)).toMatchObject({ status: 'expired', actions: { can_approve: false, can_reject: false, reason: 'expired' } })
    expect(await approve(late.id)).toMatchObject({ status: 409, body: { code: 'proposal_expired' } })
    expect((await http('POST', `/api/proposals/${late.id}/reject`)).body).toMatchObject({ code: 'proposal_expired' })
    expect((await http('GET', '/api/settings')).body.show_tps).toBe(false)
  })

  it('shows a non-owner the card without actions and refuses their approval', async () => {
    const { id } = await propose('setting', { key: 'show_token_usage', value: true })
    const hash = (await show(id)).payload_hash as string
    expect(await s.deps.proposals.get(id, false)).toMatchObject({ actions: { can_approve: false, can_reject: false, reason: 'not_owner' } })
    const apply = vi.fn()
    await expect(s.deps.proposals.approve(id, hash, false, apply)).rejects.toMatchObject({ status: 403, extra: { code: 'not_owner' } })
    await expect(s.deps.proposals.reject(id, false)).rejects.toMatchObject({ status: 403, extra: { code: 'not_owner' } })
    expect(apply).not.toHaveBeenCalled()
    expect((await show(id)).status).toBe('pending')
  })

  it.each([
    ['an unknown kind', 'secret', {}, 'kind_unknown'],
    ['a plugin at another pin', 'plugin_install', { catalog_id: 'probe', pin: 'fedcba9' }, 'pin_mismatch'],
    ['a plugin outside the catalog', 'plugin_install', { catalog_id: 'nope', pin: '0123456' }, 'plugin_unknown'],
    ['an MCP server with env values', 'mcp_server', { name: 'notes', command: 'npx', env: { TOKEN: 'secret' } }, 'payload_invalid'],
    ['an MCP server with both url and command', 'mcp_server', { name: 'notes', url: 'https://x.example', command: 'npx' }, 'payload_invalid'],
    ['a password', 'setting', { key: '_set_password', value: 'hunter2' }, 'setting_unknown'],
    ['a stored hash', 'setting', { key: 'password_hash', value: 'x' }, 'setting_unknown'],
    ['a setting of the wrong type', 'setting', { key: 'show_token_usage', value: 'yes' }, 'payload_invalid'],
    ['a task without a prompt', 'cron_job', { title: 'x', schedule: 'every 1h' }, 'payload_invalid'],
  ])('refuses %s and stores nothing', async (_name, kind, payload, expected) => {
    expect(condition((await propose(kind, payload)).reply)).toBe(expected)
    expect(await documents.list('proposals')).toEqual([])
  })

  it('links the transcript card from a propose result, and another session cannot read the proposal', async () => {
    const { reply, id } = await propose('setting', { key: 'show_token_usage', value: true })
    expect(toolOutcome(JSON.stringify((reply as { result: unknown }).result), 'propose').result_view.proposal).toEqual({ proposal_id: id, kind: 'setting', summary: 'Change setting show_token_usage' })
    expect(toolOutcome(JSON.stringify({ error: 'no', condition: 'payload_invalid' }), 'propose').result_view.proposal).toBeUndefined()
    await save('20261109_090500_other')
    expect(condition(await ask('server.proposal_read', { proposal_id: id }, '20261109_090500_other'))).toBe('proposal_unknown')
    expect(condition(await ask('server.proposal_read', { proposal_id: id }, 'nosuchsession'))).toBe('caller_unknown')
  })

  it('deletes a session\'s proposals with the session', async () => {
    sidecar.respond('state_db.delete_cli_session', () => ({ ok: true, deleted_ids: [CALLER] }))
    const { id } = await propose('setting', { key: 'show_token_usage', value: true })
    expect((await http('POST', '/api/session/delete', { session_id: CALLER })).status).toBe(200)
    expect((await http('GET', `/api/proposals/${id}`)).status).toBe(404)
    expect(await documents.list('proposals')).toEqual([])
  })
})
