/** TAL-1032: a project's bound workspaces and default model, and the new chats that inherit them. */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSidecar } from './sidecar/fake.js'
import { bootTestServer, type TestServer } from './test/harness.js'
import { writeEnvFile } from './test/env-file.js'

type Json = Record<string, unknown>

describe('project bindings', () => {
  let s: TestServer
  let a: string
  let b: string
  let pid: string
  const post = async (path: string, body: Json): Promise<{ status: number; body: Json }> => {
    const res = await s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    return { status: res.status, body: (await res.json()) as Json }
  }
  const bind = (body: Json) => post('/api/projects/bind', { project_id: pid, ...body })
  const listed = async (): Promise<Json> => (((await (await s.get('/api/projects')).json()) as Json).projects as Json[]).find((p) => p.project_id === pid)!
  const stored = (): string => readFileSync(join(s.state, 'projects.json'), 'utf8')
  const newChat = async (body: Json): Promise<Json> => {
    const res = await post('/api/session/new', body)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.session as Json
  }

  beforeAll(async () => {
    const sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    writeEnvFile(join(s.state, '.env'), { ANTHROPIC_API_KEY: 'sk-ant-test-1234', GOOGLE_API_KEY: 'g-test-1234', GEMINI_API_KEY: 'g-test-5678' })
    const config = { model: { default: 'claude-opus-4.7', provider: 'anthropic' }, providers: { ollama: { base_url: 'http://localhost:11434/v1', models: ['llama3:8b'] } } }
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: existsSync(join(p.profile_home, 'config.yaml')), config }))
    sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
    sidecar.respond('plugins.providers', () => ({ providers: [] }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: [], fallback: true }))
    a = join(s.state, 'workspace', 'alpha')
    b = join(s.state, 'workspace', 'beta')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    await s.get('/api/models')
  })
  afterAll(() => s.close())
  beforeEach(async () => { pid = String(((await post('/api/projects/create', { name: 'Bound' })).body.project as Json).project_id) })
  afterEach(() => { vi.restoreAllMocks() })

  it('saves, reads, updates and clears bindings with canonical paths and the catalog entry', async () => {
    const link = join(s.state, 'workspace', 'beta-link')
    if (!existsSync(link)) symlinkSync(b, link)
    const res = await bind({ workspaces: [a, link, b], default_workspace: link, model: 'gemini-2.5-flash', model_provider: 'google' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const canonical = [a, b].map((p) => s.deps.workspaces.resolvePath(p))
    const expected = { workspaces: canonical, default_workspace: canonical[1], model: 'gemini-2.5-flash', model_provider: 'google', model_option_id: '@google:gemini-2.5-flash' }
    expect(res.body.project).toMatchObject(expected)
    expect(await listed()).toMatchObject(expected)

    // A provider-qualified pick is split by the server; the duplicate bare id keeps its own provider.
    expect((await bind({ model: '@gemini:gemini-2.5-flash', model_provider: 'gemini' })).body.project).toMatchObject({ model: 'gemini-2.5-flash', model_provider: 'gemini', model_option_id: '@gemini:gemini-2.5-flash', workspaces: canonical })

    expect((await bind({ default_workspace: null })).body.project).toMatchObject({ workspaces: canonical, default_workspace: null })
    expect((await bind({ model: null })).body.project).toMatchObject({ model: null, model_provider: null, model_option_id: null })
    expect((await bind({ workspaces: [] })).body.project).toMatchObject({ workspaces: [], default_workspace: null })

    // Reload from disk: the store keeps exactly what the reads showed, plus every key it does not own.
    const rows = JSON.parse(stored()) as Json[]
    expect(rows.find((p) => p.project_id === pid)).toMatchObject({ name: 'Bound', workspaces: [], default_workspace: null, model: null, model_provider: null })
  })

  it('refuses an invalid request whole, leaving the store untouched', async () => {
    const outside = join(s.state, 'outside')
    mkdirSync(outside, { recursive: true })
    expect((await bind({ workspaces: [a], default_workspace: a, model: 'gemini-2.5-flash', model_provider: 'google' })).status).toBe(200)
    const before = stored()
    const refusals: Json[] = [
      { workspaces: [b], model: 'not-a-model', model_provider: 'google' },
      { workspaces: [b], model: 'gemini-2.5-flash' },
      { workspaces: [b, join(s.state, 'workspace', 'deleted')] },
      { workspaces: [b, outside] },
      { workspaces: [b, '/etc'] },
      { workspaces: [b], default_workspace: a },
      { default_workspace: b },
      { workspaces: ['   '] },
      { model_provider: 'google' },
    ]
    for (const body of refusals) {
      const res = await bind(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(stored(), JSON.stringify(body)).toBe(before)
    }
    expect((await post('/api/projects/bind', { project_id: 'missing', workspaces: [a] })).status).toBe(404)
  })

  it('hides another profile\'s project from bind and quick-create', async () => {
    const foreign = await s.deps.projects.mutate((rows) => { const p = { project_id: 'foreign12345', name: 'Theirs', profile: 'work', model: 'gemini-2.5-flash', model_provider: 'google' }; rows.push(p); return p.project_id })
    const before = stored()
    expect((await post('/api/projects/bind', { project_id: foreign, workspaces: [a] })).status).toBe(404)
    expect(stored()).toBe(before)
    expect((await post('/api/session/new', { project_id: foreign })).status).toBe(404)
    // Naming the project's profile in the body never authorizes it: the project must belong to the request's active profile.
    const worktree = vi.spyOn(s.deps.worktrees, 'create')
    const create = vi.spyOn(s.deps.sessionStore, 'newSession')
    expect((await post('/api/session/new', { project_id: foreign, profile: 'work', worktree: true })).status).toBe(404)
    expect((await post('/api/session/new', { project_id: pid, profile: 'work' })).status).toBe(404)
    expect(worktree).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps an unavailable saved choice identifiable and never re-routes it', async () => {
    await s.deps.projects.mutate((rows) => { Object.assign(rows.find((p) => p.project_id === pid)!, { model: 'retired-model', model_provider: 'custom:backup', workspace: a, extra_key: 'kept' }) })
    // A legacy single-workspace row reads as one bound default.
    expect(await listed()).toMatchObject({ model: 'retired-model', model_provider: 'custom:backup', model_option_id: null, workspaces: [a], default_workspace: a })
    // Saving other fields, or re-sending the same pair, keeps it; only a deliberate catalog pick replaces it.
    expect((await bind({ workspaces: [a, b], default_workspace: b, model: 'retired-model', model_provider: 'custom:backup' })).status).toBe(200)
    const row = (JSON.parse(stored()) as Json[]).find((p) => p.project_id === pid)!
    expect(row).toMatchObject({ model: 'retired-model', model_provider: 'custom:backup', extra_key: 'kept', workspace: s.deps.workspaces.resolvePath(b) })
    expect(await newChat({ project_id: pid })).toMatchObject({ model: 'retired-model', model_provider: 'custom:backup' })
  })

  it('starts a quick-created chat on the project defaults; explicit choices win, implicit ones do not', async () => {
    expect((await bind({ workspaces: [a, b], default_workspace: b, model: 'gemini-2.5-flash', model_provider: 'gemini' })).status).toBe(200)
    const B = s.deps.workspaces.resolvePath(b)
    const A = s.deps.workspaces.resolvePath(a)
    expect(await newChat({ project_id: pid })).toMatchObject({ project_id: pid, workspace: B, model: 'gemini-2.5-flash', model_provider: 'gemini' })
    expect(await newChat({ project_id: pid, workspace: a })).toMatchObject({ workspace: A, model: 'gemini-2.5-flash', model_provider: 'gemini' })
    expect(await newChat({ project_id: pid, model: '@google:gemini-2.5-flash' })).toMatchObject({ workspace: B, model: 'gemini-2.5-flash', model_provider: 'google' })
    expect(await newChat({ project_id: pid, model: 'claude-opus-4.7', model_provider: 'anthropic' })).toMatchObject({ model: 'claude-opus-4.7', model_provider: 'anthropic' })
    // From an open chat: its inherited workspace is not a choice, so the project default wins.
    const open = await newChat({ workspace: a })
    expect(await newChat({ project_id: pid, prev_session_id: open.session_id, workspace: a, workspace_inherited_from_prev_session: true })).toMatchObject({ workspace: B })
    // No project: the profile defaults, untouched by any project.
    expect(await newChat({ project_id: null })).toMatchObject({ project_id: null, model: 'claude-opus-4.7' })
  })

  it('creates a project worktree from the same resolved default workspace', async () => {
    expect((await bind({ workspaces: [b], default_workspace: b })).status).toBe(200)
    const B = s.deps.workspaces.resolvePath(b)
    vi.spyOn(s.deps.git, 'holdWrite').mockImplementation(async (_path, action) => action())
    const worktree = vi.spyOn(s.deps.worktrees, 'create').mockImplementation((repo) => Promise.resolve({ path: join(repo, '.wt'), branch: 'synthetic', repo_root: repo, created_at: 1 }))
    const session = await newChat({ project_id: pid, worktree: true })
    expect(worktree).toHaveBeenCalledWith(B)
    expect(session).toMatchObject({ workspace: join(B, '.wt'), worktree_repo_root: B, project_id: pid })
  })

  it('refuses a quick-create whose bound default was deleted instead of starting elsewhere', async () => {
    const gone = join(s.state, 'workspace', 'gone')
    mkdirSync(gone, { recursive: true })
    expect((await bind({ workspaces: [gone], default_workspace: gone })).status).toBe(200)
    rmSync(gone, { recursive: true })
    const create = vi.spyOn(s.deps.sessionStore, 'newSession')
    expect((await post('/api/session/new', { project_id: pid })).status).toBe(400)
    expect(create).not.toHaveBeenCalled()
  })
})
