/**
 * In-memory contract adapter (HWEB-100 seam proof).
 *
 * Implements a representative read endpoint (`GET /api/session`) and a
 * representative mutation (`POST /api/session/rename`) plus `/api/bootstrap`
 * from the schemas alone, as a `Transport` the typed client accepts. The
 * React hooks run against it unchanged, which is the property a future
 * TypeScript backend handler must satisfy.
 */
import type { Transport, TransportRequest } from '../../api/client'
import { BootstrapSchema, type Bootstrap } from '../bootstrap'
import { SessionSchema, type Session } from '../session'
import { z } from 'zod'

export interface MemoryAdapterOptions {
  bootstrap?: Partial<Bootstrap>
  sessions?: Session[]
  /** Extra routes: key `METHOD path` (path without the mount prefix), value returns `[status, body]`. */
  routes?: Record<string, (req: TransportRequest, body: unknown) => [number, unknown] | Promise<[number, unknown]>>
}

export const DEFAULT_BOOTSTRAP: Bootstrap = {
  webui_version: 'test',
  max_upload_bytes: 20 * 1024 * 1024,
  csrf_token: 'csrf-test-token',
  language: 'en',
  bot_name: 'Hermes',
  auth: { auth_enabled: true, logged_in: true, can_manage_server: true, oidc_enabled: false, password_auth_enabled: true, passkeys_enabled: false },
  profile: { name: 'default', is_default: true },
  onboarding: { completed: true },
  features: { dashboard: false, terminal_remote_backend: false, extensions: false, single_profile_mode: false },
}

export function makeSession(over: Partial<Session> = {}): Session {
  return SessionSchema.parse({
    session_id: 'sess-1',
    title: 'First session',
    workspace: '/tmp/ws',
    model: 'openai/gpt-5.4-mini',
    messages: [],
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    message_count: 0,
    pinned: false,
    archived: false,
    ...over,
  })
}

const RenameBody = z.object({ session_id: z.string(), title: z.string().min(1) })

export function createMemoryAdapter(opts: MemoryAdapterOptions = {}): Transport & { calls: TransportRequest[]; sessions: Map<string, Session> } {
  const sessions = new Map<string, Session>((opts.sessions ?? [makeSession()]).map((s) => [s.session_id, s]))
  const bootstrap = BootstrapSchema.parse({ ...DEFAULT_BOOTSTRAP, ...opts.bootstrap })
  const calls: TransportRequest[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const transport = (async (req: TransportRequest) => {
    calls.push(req)
    const path = req.url.pathname.replace(/^.*?\/api\//, '/api/')
    const key = `${req.method} ${path}`
    let body: unknown = null
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body)
      } catch {
        body = null
      }
    }
    const custom = opts.routes?.[key]
    if (custom) {
      const [status, payload] = await custom(req, body)
      return json(status, payload)
    }
    if (key === 'GET /api/bootstrap') return json(200, bootstrap)
    if (key === 'GET /api/session') {
      const id = req.url.searchParams.get('session_id') ?? ''
      const s = sessions.get(id)
      if (!s) return json(404, { error: 'Session not found' })
      const withMessages = req.url.searchParams.get('messages') !== '0'
      return json(200, { session: withMessages ? s : { ...s, messages: undefined } })
    }
    if (key === 'POST /api/session/rename') {
      const parsed = RenameBody.safeParse(body)
      if (!parsed.success) return json(400, { error: 'session_id and title are required' })
      const s = sessions.get(parsed.data.session_id)
      if (!s) return json(404, { error: 'Session not found' })
      if (req.headers.get('X-Hermes-CSRF-Token') !== bootstrap.csrf_token) return json(403, { error: 'CSRF token missing or invalid' })
      const next = { ...s, title: parsed.data.title, manual_title: true, updated_at: (s.updated_at ?? 0) + 1 }
      sessions.set(s.session_id, next)
      return json(200, { session: next })
    }
    if (key === 'GET /api/sessions') {
      const rows = [...sessions.values()].map((s) => {
        const row: Record<string, unknown> = { ...s }
        delete row.messages
        return row
      })
      return json(200, { sessions: rows, active_profile: 'default' })
    }
    return json(404, { error: 'not found' })
  }) as Transport & { calls: TransportRequest[]; sessions: Map<string, Session> }
  transport.calls = calls
  transport.sessions = sessions
  return transport
}
