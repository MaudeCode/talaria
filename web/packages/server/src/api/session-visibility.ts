/**
 * Request-supplied session ids must belong to the request's profile (Python
 * `_guard_request_session_visibility`): a top-level `session_id` in the query or
 * JSON body of any `/api/` request answers 404 when the session exists under a
 * different profile. Routes that carry ids under other keys guard themselves.
 */
import { os as orpcBase } from '@orpc/server'
import { HttpError, type ApiContext } from './router.js'
import type { RequestContext } from '../http/context.js'
import { isSafeSessionId } from '../sessions/session.js'

/** Python `_request_session_visibility_exempt`: detail-load owns the mismatch so the frontend can switch profiles; import and chat/start (placeholder retag) run their own rules. */
const EXEMPT_PROCEDURES = new Set(['sessions.get', 'sessions.import', 'chat.start'])

/** Python `_session_id_visible_to_request_profile`: unknown or unsafe ids fall through to the handler's own error. */
export function sessionIdVisibleToRequest(ctx: RequestContext, sid: unknown): boolean {
  return ctx.deps.sessions.sessionIdVisible(sid)
}

/** Pre-dispatch query guard for every `/api/` request (raw, SSE, and contract routes). */
export function guardQuerySessionId(ctx: RequestContext): boolean {
  if (ctx.method === 'GET' && ctx.path === '/api/session') return true
  if (sessionIdVisibleToRequest(ctx, ctx.query.get('session_id'))) return true
  ctx.json({ error: 'Session not found' }, { status: 404 })
  return false
}

/** Contract-route guard for the parsed input (query or JSON body) of every procedure. */
export const requestSessionIdGuard = orpcBase.$context<ApiContext>().middleware(({ context: { ctx }, path, next }, input: unknown) => {
  if (!EXEMPT_PROCEDURES.has(path.join('.'))) {
    const sid = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).session_id : undefined
    if (!sessionIdVisibleToRequest(ctx, sid)) throw new HttpError(404, 'Session not found')
  }
  return next()
})

/** Python `_stream_id_owner_session_id`: the live registry first, then the run journal once the run has finished. */
export function streamOwnerSessionId(ctx: RequestContext, streamId: string): string | null {
  const id = streamId.trim()
  if (!id) return null
  const live = ctx.deps.registry.ownerSessionId(id)
  if (live) return live
  if (!isSafeSessionId(id)) return null
  return ctx.deps.journal.findRunSummary(id)?.session_id || null
}

/** Python `_stream_id_visible_to_request_profile`: a stream is visible when its owner session is (or it has no known owner). */
export function streamVisibleToRequest(ctx: RequestContext, streamId: string): boolean {
  const owner = streamOwnerSessionId(ctx, streamId)
  return !owner || sessionIdVisibleToRequest(ctx, owner)
}
