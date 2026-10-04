import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar, loadSidecarFixtures } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { sanitizeClientEvent, updateNotificationOwner, WindowLimiter } from './tools-router.js'
import type { SessionInfo } from '../auth/store.js'
import { buildInsights } from '../tools/insights.js'
import { serverSummary, maskSecrets } from '../tools/mcp.js'
import { readProjectContext } from '../tools/memory.js'
import { toggleName, walkSkillFiles } from '../tools/skills.js'
import { UpdateService, type UpdateServiceDeps } from '../tools/updates.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, method = 'POST'): Promise<Response> => s.get(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

describe('skills, memory, prompts, commands, mcp, health, updates, diagnostics', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  const configs = new Map<string, Json>()
  const fetched: string[] = []
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    const fakeFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      fetched.push(url)
      if (url.endsWith('/api/status')) return Promise.resolve(new Response(JSON.stringify({ version: '9.9.9', app: 'hermes-dashboard' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      if (url.includes('/audio/speech') && typeof init?.body === 'string' && init.body.includes('"input":"big"')) return Promise.resolve(new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)) } }), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
      if (url.includes('/audio/speech')) return Promise.resolve(new Response(Buffer.from('ID3fake-mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
      return Promise.resolve(new Response('nope', { status: 404 }))
    }
    s = await bootTestServer({ sidecar, deps: (deps) => {
      deps.fetch = fakeFetch
      deps.dnsLookup = () => Promise.resolve([{ address: '104.18.7.192', family: 4 }])
      deps.pinnedFetch = (url, init) => fakeFetch(url, init)
      // The test server's web root is this checkout; point the updater at an npm-style install so no fetch reaches GitHub or origin.
      const original = deps.updates
      deps.updates = new UpdateService({ ...(original as unknown as { deps: UpdateServiceDeps }).deps, webRoot: join(deps.config.stateDir, 'not-a-checkout'), agentDir: () => null })
    } })
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: existsSync(join(params.profile_home, 'config.yaml')), config: configs.get(params.profile_home) ?? {} }))
    sidecar.respond('config.set', (params) => { configs.set(params.profile_home, params.config); writeFileSync(join(params.profile_home, 'config.yaml'), `# ${String(Math.random())}\n`); return { ok: true as const, path: join(params.profile_home, 'config.yaml') } })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    configs.set(s.state, { mcp_servers: { joplin: { url: 'https://notes.example/mcp', headers: { Authorization: 'Bearer secret' } }, local: { command: 'npx', args: ['server'], enabled: false }, broken: 'oops' }, webui: { dashboard: { enabled: 'auto' } }, tts: { openai: { voice: 'nova' } } })
  })
  afterAll(() => s.close())

  it('lists skills from the Agent, reads usage counters, and saves/toggles/deletes local skills', async () => {
    sidecar.respond('skills.list', (params) => ({ success: true, skills: [{ name: 'alpha', description: 'A', category: params.category ?? null, disabled: false }, { name: 'beta', description: 'B', category: null, disabled: true }], categories: [], count: 2 }))
    let res = await s.get('/api/skills?category=tools')
    expect(res.status).toBe(200)
    expect(((await json(res)).skills as Json[]).map((r) => r.name)).toEqual(['alpha', 'beta'])
    mkdirSync(join(s.state, 'skills'), { recursive: true })
    writeFileSync(join(s.state, 'skills', '.usage.json'), JSON.stringify({ alpha: { use_count: 2, view_count: '1', last_used: 'x' }, weird: 'nope' }))
    res = await s.get('/api/skills/usage')
    const usage = await json(res)
    expect(usage.total_invocations).toBe(3)
    expect(usage.unique_skills_used).toBe(1)
    expect((usage.usage as Json).alpha).toMatchObject({ use_count: 2, view_count: 1, patch_count: 0, last_used: 'x' })
    expect(usage.skill_names).toEqual(['alpha', 'beta'])
    res = await post(s, '/api/skills/save', { name: 'My Skill', content: '---\nname: my-skill\n---\n# hi', category: 'custom' })
    expect(res.status).toBe(200)
    const saved = await json(res)
    expect(saved.name).toBe('my-skill')
    expect(readFileSync(String(saved.path), 'utf8')).toContain('# hi')
    expect(walkSkillFiles(join(s.state, 'skills'))).toEqual([join(s.state, 'skills', 'custom', 'my-skill', 'SKILL.md')])
    res = await post(s, '/api/skills/save', { name: '../escape', content: 'x' })
    expect(res.status).toBe(400)
    sidecar.respond('skills.find', (params) => ({ found: params.name === 'my-skill', skill_dir: params.name === 'my-skill' ? join(s.state, 'skills', 'custom', 'my-skill') : null, skill_md: null }))
    res = await post(s, '/api/skills/toggle', { name: 'my-skill', enabled: false })
    expect(await json(res)).toEqual({ ok: true, name: 'my-skill', enabled: false })
    expect((configs.get(s.state)?.skills as Json).disabled).toEqual(['my-skill'])
    res = await post(s, '/api/skills/toggle', { name: 'my-skill', enabled: true })
    expect((configs.get(s.state)?.skills as Json).disabled).toEqual([])
    res = await post(s, '/api/skills/toggle', { name: 'ghost', enabled: true })
    expect(res.status).toBe(404)
    writeFileSync(join(s.state, 'skills', 'custom', 'my-skill', 'notes.md'), 'linked')
    res = await s.get('/api/skills/content?name=my-skill&file=notes.md')
    expect(await json(res)).toEqual({ content: 'linked', path: 'notes.md' })
    res = await s.get('/api/skills/content?name=my-skill&file=../../.usage.json')
    expect(res.status).toBe(400)
    res = await post(s, '/api/skills/delete', { name: 'my-skill' })
    expect(await json(res)).toEqual({ ok: true, name: 'my-skill' })
    expect(existsSync(join(s.state, 'skills', 'custom', 'my-skill'))).toBe(false)
    res = await post(s, '/api/skills/delete', { name: 'my-skill' })
    expect(res.status).toBe(404)
    // A category directory that is a symlink out of the skills root is never followed by the delete.
    const outside = join(s.state, 'outside-skills')
    mkdirSync(join(outside, 'victim-skill'), { recursive: true })
    writeFileSync(join(outside, 'victim-skill', 'SKILL.md'), '# victim')
    symlinkSync(outside, join(s.state, 'skills', 'linked-category'))
    res = await post(s, '/api/skills/delete', { name: 'victim-skill' })
    expect(res.status).toBe(404)
    expect(existsSync(join(outside, 'victim-skill', 'SKILL.md'))).toBe(true)
  })

  it('reads and writes memory files, honours config flags, and reports project context', async () => {
    const ws = join(s.state, 'workspace')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'AGENTS.md'), '---\ntitle: x\n---\n\n# Rules\nsk-live-1234567890abcdefghij')
    writeFileSync(join(ws, 'CLAUDE.md'), 'shadowed')
    let res = await s.get(`/api/memory?workspace=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body.memory).toBe('')
    expect(body.soul_path).toBe(join(s.state, 'SOUL.md'))
    expect(body.project_context_name).toBe('AGENTS.md')
    expect(body.project_context).toContain('# Rules')
    expect(body.project_context).not.toContain('---')
    expect(body.project_context).not.toContain('sk-live-1234567890abcdefghij')
    expect((body.project_context_shadowed as Json[])[0]).toMatchObject({ name: 'CLAUDE.md', shadowed_by: 'AGENTS.md' })
    expect(body.external_notes_enabled).toBe(false)
    res = await post(s, '/api/memory/write', { target: 'memory', content: '# remembered' })
    expect(await json(res)).toEqual({ ok: true, section: 'memory', path: join(s.state, 'memories', 'MEMORY.md') })
    res = await post(s, '/api/memory/write', { section: 'soul', content: 'soul text' })
    expect(res.status).toBe(200)
    res = await post(s, '/api/memory/write', { section: 'nope', content: 'x' })
    expect(res.status).toBe(400)
    // A symlinked USER.md is refused by the open itself (O_NOFOLLOW), not only by the pre-check, and its target is untouched.
    writeFileSync(join(s.state, 'victim.txt'), 'untouched')
    symlinkSync(join(s.state, 'victim.txt'), join(s.state, 'memories', 'USER.md'))
    res = await post(s, '/api/memory/write', { section: 'user', content: 'overwrite' })
    expect(res.status).toBe(400)
    expect(readFileSync(join(s.state, 'victim.txt'), 'utf8')).toBe('untouched')
    res = await s.get('/api/memory')
    body = await json(res)
    expect(body.memory).toBe('# remembered')
    expect(body.soul).toBe('soul text')
    expect(typeof body.memory_mtime).toBe('number')
    configs.set(s.state, { ...configs.get(s.state), memory: { memory_enabled: false } })
    writeFileSync(join(s.state, 'config.yaml'), '# bump\n')
    res = await post(s, '/api/memory/write', { section: 'memory', content: 'x' })
    expect(res.status).toBe(403)
    res = await s.get('/api/memory')
    expect((await json(res)).memory_path).toBe('')
    configs.set(s.state, { ...configs.get(s.state), memory: {} })
    writeFileSync(join(s.state, 'config.yaml'), '# bump2\n')
  })

  it('saved prompts round-trip with limits', async () => {
    let res = await s.get('/api/prompts')
    expect(await json(res)).toEqual({ prompts: [] })
    res = await post(s, '/api/prompts', { text: '  hello world  ' })
    expect(res.status).toBe(200)
    const created = (await json(res)).prompt as Json
    expect(created.label).toBe('hello world')
    expect(String(created.id)).toHaveLength(12)
    res = await post(s, '/api/prompts', { text: 'x'.repeat(8001) })
    expect(res.status).toBe(400)
    res = await post(s, '/api/prompts', {})
    expect(res.status).toBe(400)
    res = await s.get('/api/prompts')
    expect(((await json(res)).prompts as Json[]).map((p) => p.id)).toEqual([created.id])
    res = await post(s, '/api/prompts', { id: created.id }, 'DELETE')
    expect(await json(res)).toEqual({ ok: true })
    res = await s.get('/api/prompts')
    expect(await json(res)).toEqual({ prompts: [] })
  })

  it('commands list and exec go through the sidecar with error mapping', async () => {
    let res = await s.get('/api/commands')
    expect(res.status).toBe(200)
    const commands = (await json(res)).commands as Json[]
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.some((c) => c.gateway_only === true)).toBe(false)
    res = await post(s, '/api/commands/exec', { command: '/reload-skills' })
    expect((await json(res)).output).toContain('Reloaded skills')
    res = await post(s, '/api/commands/exec', { command: '' })
    expect(res.status).toBe(400)
    sidecar.respond('commands.exec', () => { throw Object.assign(new Error('unknown command'), { name: 'SidecarError' }) })
    const { SidecarError } = await import('../sidecar/client.js')
    sidecar.respond('commands.exec', () => { throw new SidecarError('unknown command', { condition: 'command_not_found' }) })
    res = await post(s, '/api/commands/exec', { command: '/nope' })
    expect(res.status).toBe(404)
  })

  it('commands list merges the client-command table ahead of the Agent registry (TAL-314)', async () => {
    const row = (name: string, extra: Json = {}) => ({ name, description: `agent ${name}`, category: 'Session', aliases: [], args_hint: '', subcommands: [], cli_only: false, gateway_only: false, ...extra })
    sidecar.respond('commands.registry', () => ({
      commands: [
        row('stop'), row('bg'), row('compress', { aliases: ['compact', 'squash'] }),
        row('reload-skills', { aliases: ['reload_skills'] }), row('history', { cli_only: true }), row('sethome', { gateway_only: true }),
      ],
    }))
    try {
      const commands = (await json(await s.get('/api/commands'))).commands as Json[]
      const names = commands.map((c) => c.name)
      // Client entries lead in display order; each name appears once and the client entry wins a clash.
      expect(names.slice(0, 3)).toEqual(['help', 'new', 'clear'])
      expect(new Set(names).size).toBe(names.length)
      expect(commands.find((c) => c.name === 'stop')).toMatchObject({ handler: 'client', clients: ['web', 'ios'] })
      // An Agent command named like a client alias is dropped, so `/bg` resolves to `background` only.
      expect(names).not.toContain('bg')
      expect(commands.find((c) => c.name === 'background')).toMatchObject({ aliases: ['bg'], handler: 'client' })
      expect(commands.find((c) => c.name === 'compress')).toMatchObject({ aliases: ['compact'], handler: 'client' })
      expect(commands.find((c) => c.name === 'branch')).toMatchObject({ aliases: ['fork'] })
      // Web-only commands carry the message other clients show.
      expect(commands.find((c) => c.name === 'terminal')).toMatchObject({ clients: ['web'], unsupported_message: 'Terminal is not available in the mobile app.' })
      expect(commands.find((c) => c.name === 'usage')?.clients).toEqual(['web'])
      // Agent rows follow, run on every client unless CLI-only, and never list gateway-only commands.
      expect(names.slice(-2)).toEqual(['reload-skills', 'history'])
      expect(commands.find((c) => c.name === 'reload-skills')).toMatchObject({ handler: 'agent', clients: ['web', 'ios'], aliases: ['reload_skills'] })
      expect(commands.find((c) => c.name === 'history')).toMatchObject({ handler: 'agent', clients: [], unsupported_message: '/history runs only in the Hermes CLI.' })
      expect(names).not.toContain('sethome')
    } finally {
      const recorded = loadSidecarFixtures().get('commands.registry')?.[0]?.result
      sidecar.respond('commands.registry', () => recorded as never)
    }
  })

  it('MCP inventory masks secrets and actions edit config.yaml', async () => {
    let res = await s.get('/api/mcp/servers')
    expect(res.status).toBe(200)
    let body = await json(res)
    const servers = body.servers as Json[]
    expect(servers.map((r) => r.name)).toEqual(['joplin', 'local', 'broken'])
    expect(servers[0]).toMatchObject({ transport: 'http', enabled: true, active: false, status: 'configured', health: 'unknown', headers: { Authorization: '••••••' } })
    expect(servers[1]).toMatchObject({ transport: 'stdio', enabled: false, status: 'disabled', health: 'not_checked' })
    expect(servers[2]).toMatchObject({ transport: 'invalid', status: 'invalid_config' })
    expect(body.toggle_supported).toBe(true)
    res = await s.get('/api/mcp/tools')
    body = await json(res)
    expect(body).toMatchObject({ tools: [], total: 0, source: 'none', unavailable_servers: ['joplin'] })
    res = await post(s, '/api/mcp/servers/local', { enabled: true })
    expect(await json(res)).toEqual({ ok: true, name: 'local', enabled: true })
    res = await post(s, '/api/mcp/servers/new-one', { url: 'https://x.example/mcp', headers: { 'X-Token': 'abc' }, timeout: '30' })
    expect(res.status).toBe(200)
    expect((await json(res)).server).toMatchObject({ name: 'new-one', transport: 'http', headers: { 'X-Token': '••••••' }, timeout: 30 })
    res = await post(s, '/api/mcp/servers/new-one', { url: 'https://x.example/mcp', headers: { 'X-Token': '••••••' } }, 'PUT')
    expect(res.status).toBe(200)
    expect(((configs.get(s.state)?.mcp_servers as Json)['new-one'] as Json).headers).toEqual({ 'X-Token': 'abc' })
    res = await post(s, '/api/mcp/servers/new-one', { enabled: false }, 'PATCH')
    expect(await json(res)).toEqual({ ok: true, name: 'new-one', enabled: false })
    res = await post(s, '/api/mcp/servers/new-one', {}, 'DELETE')
    expect(await json(res)).toEqual({ ok: true, deleted: 'new-one' })
    res = await post(s, '/api/mcp/servers/new-one', { delete: true })
    expect(res.status).toBe(404)
    res = await post(s, '/api/mcp/servers/x', { nothing: true })
    expect(res.status).toBe(400)
  })

  it('notes drawer stays disabled by default', async () => {
    let res = await s.get('/api/notes/sources')
    expect(await json(res)).toMatchObject({ enabled: false, source: 'disabled', sources: [] })
    res = await s.get('/api/notes/search?q=x')
    expect(res.status).toBe(404)
  })

  it('insights, logs, health, dashboard, plugins, and updates answer their shapes', async () => {
    let res = await s.get('/api/insights?days=7')
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body.period_days).toBe(7)
    expect((body.daily_tokens as Json[]).length).toBe(7)
    expect((body.activity_by_day as Json[]).length).toBe(7)
    res = await s.get('/api/logs?file=agent&tail=100')
    body = await json(res)
    expect(body).toMatchObject({ file: 'agent', tail: 100, lines: [], truncated: false, total_bytes: 0 })
    mkdirSync(join(s.state, 'logs'), { recursive: true })
    writeFileSync(join(s.state, 'logs', 'errors.log'), 'a\nb\nc\n')
    res = await s.get('/api/logs?file=errors&tail=7')
    body = await json(res)
    expect(body).toMatchObject({ tail: 200, lines: ['a', 'b', 'c'], total_bytes: 6, hint: '' })
    res = await s.get('/api/logs?file=../etc/passwd')
    expect(res.status).toBe(400)
    res = await s.get('/api/system/health')
    body = await json(res)
    expect(body.available).toBe(true)
    expect(typeof (body.memory as Json).percent).toBe('number')
    // Python `_webui_runtime_payload` sections.
    expect(body.webui_runtime).toMatchObject({ sessions: { available: true }, streams: { available: true, active: 0, subscriber_dropped_events: 0 }, session_list_cache: { available: false }, models_cache: { available: true } })
    expect(typeof ((body.webui_runtime as Json).sessions as Json).cap).toBe('number')
    res = await s.get('/api/health/agent')
    body = await json(res)
    expect(body.alive).toBeNull()
    expect(body.gateway_chat).toMatchObject({ enabled: false, backend: 'local' })
    res = await s.get('/api/dashboard/status')
    body = await json(res)
    expect(body).toMatchObject({ running: true, enabled: 'auto', version: '9.9.9', host: '127.0.0.1', port: 9119 })
    expect(fetched.some((u) => u === 'http://127.0.0.1:9119/api/status')).toBe(true)
    sidecar.respond('plugins.list', () => ({ plugins: [{ name: 'p', key: 'memory/p', version: '1', description: '', enabled: false, kind: 'exclusive', activation: 'exclusive', hooks: [], is_active_provider: false }], supported_hooks: ['pre_tool_call'] }))
    res = await s.get('/api/plugins')
    body = await json(res)
    expect(body.empty).toBe(false)
    expect((body.plugins as Json[])[0]).toMatchObject({ key: 'memory/p' })
    // GET answers the cache without network or git work; POST runs the check (an npm install has no checkout to fast-forward).
    res = await s.get('/api/updates/check')
    body = await json(res)
    expect(body).toMatchObject({ webui: null, agent: null, cached: true, channel: 'stable' })
    res = await post(s, '/api/updates/check', { force: true })
    body = await json(res)
    expect((body.webui as Json)).toMatchObject({ name: 'webui', manual_update: true, no_git: true, current_version: 'web-v0.0.0-test' })
    expect((body.agent as Json)).toMatchObject({ name: 'agent', behind: null, no_git: true })
    expect((await json(await s.get('/api/updates/check'))).cached).toBe(true)
    res = await post(s, '/api/updates/apply', { target: 'webui' })
    body = await json(res)
    expect(body).toMatchObject({ ok: false, manual_update: true })
    res = await post(s, '/api/updates/apply', { target: 'agent' })
    body = await json(res)
    expect(body).toMatchObject({ ok: false, message: 'Not a git repository' })
    expect(typeof body.notification_id).toBe('string')
    res = await post(s, '/api/updates/apply', { target: 'x' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/updates/summary', { updates: { webui: { behind: 2 } } })
    body = await json(res)
    expect(body.generated_by).toBe('fallback')
    expect(body.summary).toContain('WebUI has 2 update(s) available.')
    res = await post(s, '/api/settings', { check_for_updates: false })
    expect(res.status).toBe(200)
    res = await s.get('/api/updates/check')
    expect(await json(res)).toEqual({ disabled: true })
    res = await post(s, '/api/updates/check', { force: true })
    expect((await json(res)).channel).toBe('stable')
    res = await s.get('/api/transcribe/capability')
    expect(await json(res)).toEqual({ ok: true, available: false, provider: 'none' })
  })

  it('shutdown and restart are operator-gated and restart maps sidecar outcomes', async () => {
    sidecar.respond('gateway.restart', () => ({ status: 'busy', message: 'Restart already in progress. Please wait a moment and try again.' }))
    let res = await post(s, '/api/health/restart', {})
    expect(res.status).toBe(429)
    sidecar.respond('gateway.restart', () => ({ status: 'completed', message: 'ok' }))
    res = await post(s, '/api/health/restart', {})
    expect(await json(res)).toEqual({ ok: true, message: 'Gateway service restarted successfully' })
    const original = s.deps.requestShutdown
    let requested = false
    s.deps.requestShutdown = () => { requested = true }
    res = await post(s, '/api/shutdown', {})
    expect(await json(res)).toEqual({ status: 'shutting_down' })
    expect(requested).toBe(true)
    s.deps.requestShutdown = original
  })

  it('owns update notification lifecycle through typed HTTP routes', async () => {
    let res = await s.get('/api/update-notifications')
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(typeof body.unread_count).toBe('number')
    expect(typeof body.clearable_count).toBe('number')
    expect(typeof body.can_clear).toBe('boolean')
    expect(typeof body.scope_id).toBe('string')

    res = await post(s, '/api/updates/apply', { target: 'webui' })
    const applied = await json(res)
    expect(applied.ok).toBe(false)
    const notificationID = String(applied.notification_id)
    expect(notificationID).toMatch(/^[0-9a-f-]{36}$/)

    body = await json(await s.get('/api/update-notifications'))
    const notification = (body.notifications as Json[]).find((row) => row.id === notificationID)
    expect(notification).toMatchObject({ kind: 'update', target: 'webui', phase: 'failed', read_at: null, destination: { key: 'settings.system' } })

    res = await post(s, `/api/update-notifications/${notificationID}/read`, { read: true })
    const readNotification = await json(res)
    expect(readNotification.id).toBe(notificationID)
    expect(typeof readNotification.read_at).toBe('string')
    res = await post(s, '/api/update-notifications/clear', { clear: true })
    body = await json(res)
    expect((body.notifications as Json[]).some((row) => row.id === notificationID)).toBe(false)
    expect(body.clearable_count).toBe(0)
    expect(body.can_clear).toBe(false)
  })

  it('compares a Web tab build and keeps its refresh notice tab-scoped until the reloaded build is verified', async () => {
    const oldBuild = 'a'.repeat(64)
    const newBuild = 'b'.repeat(64)
    const originalBuildId = s.deps.spa.buildId.bind(s.deps.spa)
    let current: string | null = newBuild
    s.deps.spa.buildId = () => current
    try {
      const list = async (query: string) => json(await s.get(`/api/update-notifications${query}`))
      const res = await s.get('/api/update-notifications?tab_id=tab-aaaaaaaa&loaded_build=' + oldBuild)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      let body = await json(res)
      const id = String((body.frontend_build as Json).notification_id)
      expect(body.frontend_build).toEqual({ current_build: newBuild, loaded_build: oldBuild, refresh_required: true, notification_id: id })
      expect((body.notifications as Json[]).filter((row) => row.kind === 'web_refresh')).toMatchObject([{ id, requires_interaction: true, can_dismiss: false, actions: [{ id: 'reload', acknowledges: false }] }])

      body = await list('')
      expect(body.frontend_build).toEqual({ current_build: newBuild, loaded_build: null, refresh_required: false, notification_id: null })
      expect((body.notifications as Json[]).some((row) => row.id === id)).toBe(false)
      body = await list('?tab_id=tab-bbbbbbbb&loaded_build=' + newBuild)
      expect((body.notifications as Json[]).some((row) => row.id === id)).toBe(false)
      expect((await s.get(`/api/update-notifications?tab_id=x&loaded_build=${oldBuild}`)).status).toBe(400)

      expect((await post(s, `/api/update-notifications/${id}/read`, { read: true })).status).toBe(404)
      expect(await json(await post(s, `/api/update-notifications/${id}/read`, { read: true, tab_id: 'tab-aaaaaaaa' }))).toMatchObject({ unread: false, requires_interaction: true })
      expect((await post(s, `/api/update-notifications/${id}/dismiss`, { dismiss: true, tab_id: 'tab-aaaaaaaa' })).status).toBe(409)
      body = await json(await post(s, '/api/update-notifications/clear', { clear: true, tab_id: 'tab-aaaaaaaa', loaded_build: oldBuild }))
      expect((body.notifications as Json[]).map((row) => row.id)).toContain(id)
      expect(body.frontend_build).toMatchObject({ refresh_required: true, notification_id: id })
      expect(await json(await post(s, `/api/update-notifications/${id}/actions/reload`, { perform: true, tab_id: 'tab-aaaaaaaa' }))).toMatchObject({ requires_interaction: true })

      current = null
      body = await list('?tab_id=tab-aaaaaaaa&loaded_build=' + newBuild)
      expect(body.frontend_build).toMatchObject({ current_build: null, refresh_required: false })
      expect((body.notifications as Json[]).map((row) => row.id)).toContain(id)

      current = newBuild
      body = await list('?tab_id=tab-aaaaaaaa&loaded_build=' + newBuild)
      expect(body.frontend_build).toEqual({ current_build: newBuild, loaded_build: newBuild, refresh_required: false, notification_id: null })
      expect((body.notifications as Json[]).some((row) => row.id === id)).toBe(false)
    } finally {
      s.deps.spa.buildId = originalBuildId
    }
  })

  it('keeps an Agent stash conflict\'s recovery instructions on the succeeded notification', async () => {
    const originalApply = s.deps.updates.apply.bind(s.deps.updates)
    const message = 'agent updated to v2.0.0. Your local modifications could not be re-applied cleanly and were set aside in the git stash.'
    s.deps.updates.apply = () => Promise.resolve({ ok: true, target: 'agent', stash_conflict: true, message })
    try {
      const result = await json(await post(s, '/api/updates/apply', { target: 'agent' }))
      const listed = await json(await s.get('/api/update-notifications'))
      expect((listed.notifications as Json[]).find((row) => row.id === result.notification_id)).toMatchObject({ phase: 'succeeded', detail: message })
    } finally {
      s.deps.updates.apply = originalApply
    }
  })

  it('deduplicates concurrent update requests onto one server lifecycle record', async () => {
    const originalApply = s.deps.updates.apply.bind(s.deps.updates)
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    let calls = 0
    s.deps.updates.apply = async () => { calls += 1; await gate; return { ok: false, message: 'fixture failure' } }
    try {
      const first = post(s, '/api/updates/apply', { target: 'webui' })
      for (let attempt = 0; attempt < 20 && calls === 0; attempt += 1) await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(calls).toBe(1)
      const cleared = await json(await post(s, '/api/update-notifications/clear', { clear: true }))
      expect(cleared.notifications).toEqual([])
      const duplicate = await json(await post(s, '/api/updates/apply', { target: 'webui' }))
      expect(duplicate).toMatchObject({ ok: false, status: 'already_in_progress' })
      expect(typeof duplicate.notification_id).toBe('string')
      expect(calls).toBe(1)
      finish()
      const completed = await json(await first)
      expect(completed.notification_id).toBe(duplicate.notification_id)
      const listed = await json(await s.get('/api/update-notifications'))
      expect((listed.notifications as Json[]).filter((row) => row.id === completed.notification_id)).toHaveLength(0)
    } finally {
      finish()
      s.deps.updates.apply = originalApply
    }
  })

  it('names the update operation each tab started, even once cleared, and never an automatic one', async () => {
    const originalApply = s.deps.updates.apply.bind(s.deps.updates)
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    let calls = 0
    s.deps.updates.apply = async () => { calls += 1; await gate; return { ok: false, message: 'fixture failure' } }
    const tabUpdate = async (tab: string) => (await json(await s.get(`/api/update-notifications?tab_id=${tab}`))).tab_update as Json | null
    try {
      const automatic = s.deps.updateNotifications.begin({ owner: '*', profile: 'default', serverOwner: true }, 'agent')
      s.deps.updateNotifications.transition(automatic.id, 'succeeded')
      expect(await tabUpdate('tab-starter')).toBeNull()
      const first = post(s, '/api/updates/apply', { target: 'webui', tab_id: 'tab-starter' })
      for (let attempt = 0; attempt < 20 && calls === 0; attempt += 1) await new Promise<void>((resolve) => { setImmediate(resolve) })
      const started = await tabUpdate('tab-starter')
      expect(started).toMatchObject({ kind: 'update', target: 'webui', phase: 'applying', active: true })
      expect(await tabUpdate('tab-bystander')).toBeNull()
      expect((await json(await s.get('/api/update-notifications'))).tab_update).toBeNull()
      const rejoined = await json(await post(s, '/api/updates/apply', { target: 'webui', tab_id: 'tab-rejoiner' }))
      expect(rejoined).toMatchObject({ status: 'already_in_progress', notification_id: started!.id })
      expect((await tabUpdate('tab-rejoiner'))?.id).toBe(started!.id)
      await post(s, '/api/update-notifications/clear', { clear: true })
      finish()
      expect((await json(await first)).notification_id).toBe(started!.id)
      expect(await tabUpdate('tab-starter')).toMatchObject({ id: started!.id, phase: 'failed', active: false, detail: 'fixture failure' })
      expect((await post(s, '/api/updates/apply', { target: 'webui', tab_id: 'x' })).status).toBe(400)
    } finally {
      finish()
      s.deps.updates.apply = originalApply
    }
  })

  it('transcribe proxies multipart audio to the sidecar; tts proxies openai and rate limits', async () => {
    sidecar.respond('stt.transcribe', (params) => ({ transcript: `heard ${String(Buffer.from(params.audio_b64, 'base64').length)} bytes${params.suffix ?? ''}` }))
    const boundary = 'abc'
    const body = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="clip.webm"', 'Content-Type: audio/webm', '', 'audio-bytes', `--${boundary}--`, ''].join('\r\n')
    let res = await s.get('/api/transcribe', { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, transcript: 'heard 11 bytes.webm' })
    res = await s.get('/api/transcribe', { method: 'POST', body: '--x--', headers: { 'content-type': 'multipart/form-data; boundary=x' } })
    expect(res.status).toBe(400)
    res = await post(s, '/api/tts', { text: 'hi', engine: 'openai' })
    expect(res.status).toBe(503)
    writeFileSync(join(s.state, '.env'), 'OPENAI_API_KEY=sk-test-1234\n')
    chmodSync(join(s.state, '.env'), 0o600)
    // An unbounded upstream body is cut off at the 16 MiB cap instead of being buffered.
    s.deps.ttsLimiter = new WindowLimiter(2, 1)
    res = await post(s, '/api/tts', { text: 'big', engine: 'openai' })
    expect(res.status).toBe(502)
    s.deps.ttsLimiter = new WindowLimiter(2, 1)
    res = await post(s, '/api/tts', { text: 'hi', engine: 'openai' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('ID3fake-mp3')
    res = await post(s, '/api/tts', { text: 'again', engine: 'openai' })
    expect(res.status).toBe(429)
    res = await post(s, '/api/tts', { text: '', engine: 'openai' })
    expect(res.status).toBe(400)
    s.deps.ttsLimiter = new WindowLimiter(2, 1)
    res = await post(s, '/api/tts', { text: 'x', engine: 'edge' })
    expect(res.status).toBe(503) // Edge TTS is a decided removal; the matrix documents the 503
  })

  it('client events are sanitised and csp reports are accepted without auth', async () => {
    let res = await post(s, '/api/client-events/log', { event: 'sse_closed', url_path: 'https://evil/x?token=1', reason: 'r'.repeat(500), cookie: 'secret' })
    expect(await json(res)).toEqual({ ok: true, event: 'sse_closed' })
    expect(sanitizeClientEvent({ event: 'e', url_path: 'https://evil/x?token=1', reason: 'r'.repeat(500), cookie: 'x' })).toEqual({ event: 'e', url_path: '/x', reason: 'r'.repeat(160) })
    expect(sanitizeClientEvent('nope')).toEqual({ event: 'unknown' })
    expect(sanitizeClientEvent({ event: 'net', ready_state: 2, online: 'no' })).toEqual({ event: 'net', ready_state: 2, online: false })
    expect(sanitizeClientEvent({ event: 'net', ready_state: true, online: 'maybe' })).toEqual({ event: 'net' })
    res = await s.get('/api/csp-report', { method: 'POST', body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }), headers: { 'content-type': 'application/csp-report' } })
    expect(res.status).toBe(204)
    expect(s.logs.some((l) => l.includes('[csp-report]') && l.includes('script-src'))).toBe(true)
  })
})

describe('tools helpers', () => {
  it('keys OIDC notifications by stable issuer and subject without cross-owner sharing', () => {
    const session = (token: string, issuer: string, subject: string, boundProfile = 'work'): SessionInfo => ({
      token, expiry: 2_000_000_000, auth_type: 'oidc', username: 'shared@example.test', bound_profile: boundProfile,
      oidc_issuer: issuer, oidc_subject: subject,
    })
    const first = updateNotificationOwner(session('token-a', 'https://issuer.example', 'principal-a'))
    expect(updateNotificationOwner(session('token-b', 'https://issuer.example', 'principal-a'))).toBe(first)
    expect(updateNotificationOwner(session('token-c', 'https://issuer.example', 'principal-a', 'personal'))).toBe(first)
    expect(updateNotificationOwner(session('token-d', 'https://issuer.example', 'principal-b'))).not.toBe(first)
    expect(updateNotificationOwner(session('token-e', 'https://other-issuer.example', 'principal-a'))).not.toBe(first)
    expect(updateNotificationOwner(session('token-f', 'https://issuer.example', 'principal-a '))).not.toBe(first)
    expect(first.length).toBeLessThanOrEqual(256)

    const legacy = (token: string): SessionInfo => ({ token, expiry: 2_000_000_000, auth_type: 'oidc', username: 'shared@example.test', bound_profile: 'work' })
    expect(updateNotificationOwner(legacy('legacy-a'))).not.toBe(updateNotificationOwner(legacy('legacy-b')))
  })

  it('window limiter, toggle list, mcp summary, project context', () => {
    let t = 0
    const limiter = new WindowLimiter(60, 2, () => t)
    expect(limiter.limited('a')).toBe(false)
    expect(limiter.limited('a')).toBe(false)
    expect(limiter.limited('a')).toBe(true)
    t = 61
    expect(limiter.limited('a')).toBe(false)
    expect(toggleName('a, b', 'b', true)).toEqual(['a'])
    expect(toggleName(['a'], 'b', false)).toEqual(['a', 'b'])
    expect(maskSecrets({ API_KEY: 'x', nested: { token: 'y', ok: 'z' } })).toEqual({ API_KEY: '••••••', nested: { token: '••••••', ok: 'z' } })
    expect(serverSummary('s', { command: 'run', env: { SECRET: 'x' } }, { connected: true, tools: [1, 2] })).toMatchObject({ transport: 'stdio', active: true, status: 'active', tool_count: 2, env: { SECRET: '••••••' } })
    expect(readProjectContext(null)).toMatchObject({ content: '', path: '' })
    const now = 1_760_000_000
    const insights = buildInsights([{ created_at: now - 100, updated_at: now - 50, input_tokens: 10, output_tokens: 5, cache_read_tokens: 5, estimated_cost: '$0.5', message_count: 3, model: 'm' }, { created_at: now - 10 * 86_400 * 4 }], '3', now)
    expect(insights).toMatchObject({ period_days: 3, total_sessions: 1, total_messages: 3, total_tokens: 15, total_cost: 0.5, total_cache_hit_percent: 33 })
    expect((insights.models as Json[])[0]).toMatchObject({ model: 'm', sessions: 1, session_share: 100, cost_share: 100 })
  })
})
