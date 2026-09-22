import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { createTalariaMcpServer } from './server.js'

type Json = Record<string, unknown>

async function connect(s: TestServer, opts: { password?: string | null; profile?: string | null } = {}): Promise<Client> {
  const server = createTalariaMcpServer({ baseUrl: s.base, password: opts.password ?? null, profile: opts.profile ?? null })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientTransport)
  return client
}

async function call(client: Client, name: string, args: Json = {}): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args })
  const content = (result.content as { type: string; text: string }[])[0]
  return JSON.parse(content?.text ?? 'null') as unknown
}

describe('talaria-web-mcp', () => {
  let s: TestServer
  let client: Client
  beforeAll(async () => {
    s = await bootTestServer({ sidecar: new FakeSidecar() })
    client = await connect(s)
  })
  afterAll(async () => { await client.close(); await s.close() })

  it('advertises the seven Python tools by name', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(['create_project', 'delete_project', 'list_projects', 'list_sessions', 'move_session', 'rename_project', 'rename_session'])
  })

  it('creates, lists, renames, and deletes projects through the HTTP API', async () => {
    expect(await call(client, 'create_project', { name: '  ' })).toEqual({ error: 'name is required' })
    expect(await call(client, 'create_project', { name: 'Bad', color: 'red' })).toMatchObject({ error: expect.stringContaining('Invalid color format') as unknown })
    const created = (await call(client, 'create_project', { name: 'Alpha', color: '#abc' })) as Json
    expect(created).toMatchObject({ name: 'Alpha', color: '#abc', profile: 'default', session_count: 0 })
    expect(String(created.project_id)).toHaveLength(12)
    expect(await call(client, 'create_project', { name: 'Alpha' })).toEqual({ error: "Project 'Alpha' already exists" })
    const listed = (await call(client, 'list_projects')) as Json[]
    expect(listed.map((p) => p.name)).toContain('Alpha')
    const renamed = (await call(client, 'rename_project', { project_id: created.project_id, name: 'Beta', color: '#123456' })) as Json
    expect(renamed).toMatchObject({ project_id: created.project_id, name: 'Beta', color: '#123456' })
    expect(await call(client, 'rename_project', { project_id: 'missing000000', name: 'x' })).toEqual({ error: 'Project not found' })
    expect(await call(client, 'delete_project', { project_id: 'missing000000' })).toEqual({ error: 'Project not found' })
    const deleted = (await call(client, 'delete_project', { project_id: created.project_id })) as Json
    expect(deleted).toEqual({ ok: true, deleted: 'Beta', unassigned_sessions: 0 })
  })

  it('reports the sessions the delete route unassigned even when auth is off', async () => {
    // The TS MCP always mutates through the HTTP API (the Python one edited the projects file directly without auth),
    // so the delete route's own unassignment is what the count reflects.
    const res = await s.get('/api/session/new', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    const sid = String((((await res.json()) as Json).session as Json).session_id)
    const project = (await call(client, 'create_project', { name: 'Epsilon' })) as Json
    expect(await call(client, 'rename_session', { session_id: sid, title: 'Counted' })).toMatchObject({ ok: true })
    expect(await call(client, 'move_session', { session_id: sid, project_id: project.project_id })).toMatchObject({ ok: true })
    const deleted = (await call(client, 'delete_project', { project_id: project.project_id })) as Json
    expect(deleted).toEqual({ ok: true, deleted: 'Epsilon', unassigned_sessions: 1 })
    expect(((await call(client, 'list_sessions', { unassigned: true })) as Json[]).map((r) => r.session_id)).toContain(sid)
  })

  it('renames and moves sessions, then counts them under projects', async () => {
    const res = await s.get('/api/session/new', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    const sid = String((((await res.json()) as Json).session as Json).session_id)
    const project = (await call(client, 'create_project', { name: 'Gamma' })) as Json
    expect(await call(client, 'rename_session', { session_id: sid, title: 'Renamed by MCP' })).toEqual({ ok: true, session_id: sid, title: 'Renamed by MCP', method: 'api' })
    expect(await call(client, 'move_session', { session_id: sid, project_id: 'missing000000' })).toEqual({ error: 'Project not found' })
    expect(await call(client, 'move_session', { session_id: sid, project_id: project.project_id })).toMatchObject({ ok: true, session_id: sid, project_id: project.project_id, method: 'api' })
    const inProject = (await call(client, 'list_sessions', { project_id: project.project_id })) as Json[]
    expect(inProject.map((r) => r.session_id)).toEqual([sid])
    expect(inProject[0]).toMatchObject({ title: 'Renamed by MCP', project_id: project.project_id, profile: 'default', is_cli_session: false })
    expect(((await call(client, 'list_projects')) as Json[]).find((p) => p.project_id === project.project_id)).toMatchObject({ session_count: 1 })
    expect(((await call(client, 'list_sessions', { unassigned: true })) as Json[]).map((r) => r.session_id)).not.toContain(sid)
    expect(await call(client, 'move_session', { session_id: sid, project_id: null })).toMatchObject({ ok: true, project_id: null })
    expect(await call(client, 'rename_session', { session_id: 'nope', title: 'x' })).toEqual({ error: 'API 404: Session not found' })
  })

  it('logs in with the password and unassigns sessions on delete when authenticated', async () => {
    await s.deps.settings.save({ _set_password: 'hunter22' })
    s.deps.auth.invalidatePasswordHashCache()
    const anon = await connect(s)
    expect(await call(anon, 'rename_session', { session_id: 'x', title: 'y' })).toEqual({ error: 'API 401: Authentication required' })
    await anon.close()
    const authed = await connect(s, { password: 'hunter22' })
    const res = await s.get('/api/session/new', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', cookie: `${s.deps.auth.cookieName()}=${s.deps.auth.createSession({ authType: 'password' })}` } })
    const sid = String((((await res.json()) as Json).session as Json).session_id)
    const project = (await call(authed, 'create_project', { name: 'Delta' })) as Json
    expect(await call(authed, 'rename_session', { session_id: sid, title: 'Authed' })).toMatchObject({ ok: true })
    expect(await call(authed, 'move_session', { session_id: sid, project_id: project.project_id })).toMatchObject({ ok: true })
    const deleted = (await call(authed, 'delete_project', { project_id: project.project_id })) as Json
    expect(deleted).toEqual({ ok: true, deleted: 'Delta', unassigned_sessions: 1 })
    await authed.close()
    await s.deps.settings.save({ _clear_password: true })
    s.deps.auth.invalidatePasswordHashCache()
  })

  it('pins --profile through a session-signed cookie when auth is on, and refuses to fall back to the default profile', async () => {
    mkdirSync(join(s.state, 'profiles', 'mcpprof'), { recursive: true })
    await s.deps.settings.save({ _set_password: 'hunter22' })
    s.deps.auth.invalidatePasswordHashCache()
    const pinned = await connect(s, { password: 'hunter22', profile: 'mcpprof' })
    const created = (await call(pinned, 'create_project', { name: 'Pinned' })) as Json
    expect(created).toMatchObject({ name: 'Pinned', profile: 'mcpprof' })
    expect(((await call(pinned, 'list_projects')) as Json[]).map((p) => p.name)).toContain('Pinned')
    const owner = `${s.deps.auth.cookieName()}=${s.deps.auth.createSession({ authType: 'password' })}`
    const defaultProjects = (await (await s.get('/api/projects', { headers: { cookie: owner } })).json()) as Json
    expect((defaultProjects.projects as Json[]).map((p) => p.name)).not.toContain('Pinned')
    await pinned.close()
    const ghost = await connect(s, { password: 'hunter22', profile: 'no-such-profile' })
    expect(await call(ghost, 'list_projects')).toMatchObject({ error: expect.stringContaining("Profile 'no-such-profile' could not be selected") as unknown })
    await ghost.close()
    await s.deps.settings.save({ _clear_password: true })
    s.deps.auth.invalidatePasswordHashCache()
  })
})
