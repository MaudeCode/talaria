/**
 * `talaria-web-mcp`: the seven project/session tools of Python `mcp_server.py`,
 * served over MCP. Every tool goes through the Web HTTP API (no in-process
 * state reads): a password from `HERMES_WEBUI_PASSWORD` logs in once and the
 * session cookie is reused; `--profile` pins the profile cookie. With auth on,
 * the server only honours a profile cookie signed to the session, so the
 * client obtains it from `/api/profile/switch` after login instead of
 * synthesizing one.
 */
import { readCapped } from '../http/capped.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export interface McpClientOptions {
  baseUrl: string
  password: string | null
  profile: string | null
  fetch?: typeof fetch
  now?: () => number
}

type Json = Record<string, unknown>
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/
const AUTH_REUSE_S = 25 * 86400

/** Thin authenticated HTTP client mirroring `_api_auth` / `_api_post`. */
export class WebApiClient {
  private cookie: string | null = null
  private cookieExpires = 0
  private profileCookie: string | null = null
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly opts: McpClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch
    this.now = opts.now ?? (() => Date.now() / 1000)
  }

  private async auth(): Promise<string | null> {
    if (!this.opts.password) return null
    if (this.cookie && this.now() < this.cookieExpires) return this.cookie
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: this.opts.password }), signal: AbortSignal.timeout(5000) })
      const cookie = setCookies(res).find((c) => c.includes('='))
      if (cookie) {
        this.profileCookie = this.opts.profile ? await this.signedProfileCookie(cookie) : null
        this.cookie = cookie
        this.cookieExpires = this.now() + AUTH_REUSE_S
        return cookie
      }
    } catch { this.cookie = null }
    return null
  }

  /** The session-signed profile cookie the switch route issues; null when the profile cannot be selected. */
  private async signedProfileCookie(sessionCookie: string): Promise<string | null> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/profile/switch`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie }, body: JSON.stringify({ name: this.opts.profile }), signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const sessionName = sessionCookie.split('=')[0] ?? ''
    return setCookies(res).find((c) => c.includes('=') && c.split('=')[0] !== sessionName) ?? null
  }

  private async headers(json: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {}
    const cookies: string[] = []
    const auth = await this.auth()
    if (auth) {
      cookies.push(auth)
      if (this.opts.profile) {
        // Never fall through to the process-default profile: an unsigned cookie is ignored once auth is on.
        if (!this.profileCookie) throw new Error(`Profile '${this.opts.profile}' could not be selected`)
        cookies.push(this.profileCookie)
      }
    } else if (this.opts.profile) cookies.push(`hermes_profile=${encodeURIComponent(this.opts.profile)}`)
    if (cookies.length) headers.Cookie = cookies.join('; ')
    return headers
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Json> {
    let res: Response
    try {
      const headers = await this.headers(body !== undefined)
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) })
    } catch (error) {
      return { error: `API unreachable: ${(error as Error).message}` }
    }
    let payload: unknown = null
    try { const raw = await readCapped(res, 8 * 1024 * 1024); payload = raw ? JSON.parse(raw.toString('utf8')) : null } catch { payload = null }
    const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Json) : {}
    if (!res.ok) return { error: `API ${String(res.status)}: ${typeof data.error === 'string' ? data.error : 'unknown'}` }
    return data
  }

  get(path: string): Promise<Json> { return this.request('GET', path) }
  post(path: string, body: unknown): Promise<Json> { return this.request('POST', path, body) }
  hasAuth(): boolean { return Boolean(this.opts.password) }
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(';')[0] ?? '')
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
const errorText = (message: string) => text({ error: message })

function sessionCompact(row: Json): Json {
  return { session_id: row.session_id, title: row.title, project_id: row.project_id ?? null, workspace: row.workspace, model: row.model, message_count: row.message_count ?? 0, source_tag: row.source_tag ?? null, is_cli_session: row.is_cli_session ?? false, profile: row.profile }
}

/** Every session of the profile, including empty drafts (Python read the raw index; the search route is the API equivalent). */
async function allSessions(api: WebApiClient): Promise<Json[] | { error: string }> {
  const res = await api.get('/api/sessions/search?q=&content=0')
  if (typeof res.error === 'string') return { error: res.error }
  return Array.isArray(res.sessions) ? (res.sessions as Json[]).filter((s) => s.session_id) : []
}

export function createTalariaMcpServer(opts: McpClientOptions): McpServer {
  const api = new WebApiClient(opts)
  const server = new McpServer({ name: 'talaria-web', version: '1.0.0' })

  server.registerTool('list_projects', { description: 'List all session projects with their IDs, names, colors, and session counts (scoped to active profile).', inputSchema: {} }, async () => {
    const projects = await api.get('/api/projects')
    if (typeof projects.error === 'string') return errorText(projects.error)
    const sessions = await allSessions(api)
    const counts = new Map<string, number>()
    if (Array.isArray(sessions)) for (const s of sessions) { const pid = typeof s.project_id === 'string' ? s.project_id : ''; if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1) }
    return text((Array.isArray(projects.projects) ? (projects.projects as Json[]) : []).map((p) => ({ ...p, session_count: counts.get(String(p.project_id)) ?? 0 })))
  })

  server.registerTool('create_project', { description: 'Create a new project for organizing sessions (profile-scoped).', inputSchema: { name: z.string().describe('Project name (max 128 chars)'), color: z.string().optional().describe('Optional hex color (#RGB, #RRGGBB, or #RRGGBBAA)') } }, async ({ name, color }) => {
    const trimmed = name.trim().slice(0, 128)
    if (!trimmed) return errorText('name is required')
    if (color !== undefined && !COLOR_RE.test(color)) return errorText('Invalid color format (use #RGB, #RRGGBB, or #RRGGBBAA)')
    const existing = await api.get('/api/projects')
    if (typeof existing.error === 'string') return errorText(existing.error)
    if ((Array.isArray(existing.projects) ? (existing.projects as Json[]) : []).some((p) => p.name === trimmed)) return errorText(`Project '${trimmed}' already exists`)
    const created = await api.post('/api/projects/create', { name: trimmed, color: color ?? null })
    if (typeof created.error === 'string') return errorText(created.error)
    return text({ ...(created.project as Json), session_count: 0 })
  })

  server.registerTool('rename_project', { description: 'Rename a project and optionally change its color (profile-checked).', inputSchema: { project_id: z.string().describe('12-char project ID'), name: z.string().describe('New name (max 128 chars)'), color: z.string().optional().describe('Optional new hex color') } }, async ({ project_id, name, color }) => {
    const trimmed = name.trim().slice(0, 128)
    if (!project_id || !trimmed) return errorText('project_id and name are required')
    if (color !== undefined && !COLOR_RE.test(color)) return errorText('Invalid color format (use #RGB, #RRGGBB, or #RRGGBBAA)')
    const renamed = await api.post('/api/projects/rename', { project_id, name: trimmed, ...(color !== undefined ? { color } : {}) })
    if (typeof renamed.error === 'string') return errorText(renamed.error.replace(/^API 404: /, ''))
    return text(renamed.project)
  })

  server.registerTool('delete_project', { description: 'Delete a project and unassign all its sessions (profile-checked).', inputSchema: { project_id: z.string().describe('12-char project ID to delete') } }, async ({ project_id }) => {
    if (!project_id) return errorText('project_id is required')
    const projects = await api.get('/api/projects')
    if (typeof projects.error === 'string') return errorText(projects.error)
    const proj = (Array.isArray(projects.projects) ? (projects.projects as Json[]) : []).find((p) => p.project_id === project_id)
    if (!proj) return errorText('Project not found')
    // The delete route unassigns every session of the project itself (cache-safe, whether or not auth is on), so the
    // count is what the server listed under the project right before the delete — the Python MCP only ever had to
    // move sessions by hand because it edited the projects file directly.
    const sessions = await allSessions(api)
    const unassigned = Array.isArray(sessions) ? sessions.filter((row) => row.project_id === project_id).length : null
    const deleted = await api.post('/api/projects/delete', { project_id })
    if (typeof deleted.error === 'string') return errorText(deleted.error.replace(/^API 404: /, ''))
    const result: Json = { ok: true, deleted: proj.name, unassigned_sessions: unassigned ?? 0 }
    if (unassigned === null) result.warning = 'The session list could not be read before the delete; the project was deleted and its sessions unassigned, but the count is unknown.'
    return text(result)
  })

  server.registerTool('rename_session', { description: 'Rename a session (updates sidebar via authenticated API, cache-safe).', inputSchema: { session_id: z.string().describe('Session ID'), title: z.string().describe('New title (max 80 chars)') } }, async ({ session_id, title }) => {
    const trimmed = title.trim().slice(0, 80)
    if (!session_id || !trimmed) return errorText('session_id and title are required')
    const result = await api.post('/api/session/rename', { session_id, title: trimmed })
    if (typeof result.error === 'string') return text(result)
    const session = (result.session ?? {}) as Json
    return text({ ok: true, session_id, title: session.title ?? trimmed, method: 'api' })
  })

  server.registerTool('move_session', { description: 'Assign a session to a project. Pass project_id=null to unassign. Uses authenticated API for cache safety (profile-checked).', inputSchema: { session_id: z.string().describe('Session ID'), project_id: z.string().nullable().describe('Project ID (or null to unassign)') } }, async ({ session_id, project_id }) => {
    if (!session_id) return errorText('session_id is required')
    if (project_id !== null) {
      const projects = await api.get('/api/projects')
      if (typeof projects.error === 'string') return errorText(projects.error)
      if (!(Array.isArray(projects.projects) ? (projects.projects as Json[]) : []).some((p) => p.project_id === project_id)) return errorText('Project not found')
    }
    const result = await api.post('/api/session/move', { session_id, project_id })
    if (typeof result.error === 'string') return text(result)
    const session = (result.session ?? {}) as Json
    return text({ ok: true, session_id, project_id, title: session.title ?? null, method: 'api' })
  })

  server.registerTool('list_sessions', { description: 'List sessions, optionally filtered by project or unassigned status (profile-scoped).', inputSchema: { project_id: z.string().optional().describe('Filter sessions by project ID'), unassigned: z.boolean().optional().describe('Show only sessions with no project'), limit: z.number().int().optional().describe('Max results (default: 50, max: 500)') } }, async ({ project_id, unassigned, limit }) => {
    const sessions = await allSessions(api)
    if (!Array.isArray(sessions)) return errorText(sessions.error)
    let rows = sessions.map(sessionCompact)
    if (unassigned) rows = rows.filter((r) => !r.project_id)
    else if (project_id) rows = rows.filter((r) => r.project_id === project_id)
    return text(rows.slice(0, Math.max(1, Math.min(500, limit ?? 50))))
  })

  return server
}
