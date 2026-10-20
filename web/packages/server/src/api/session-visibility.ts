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
const EXEMPT_PROCEDURES = new Set(['session.get', 'session.import', 'chat.start'])

/** Python `_session_id_visible_to_request_profile`: unknown or unsafe ids fall through to the handler's own error. */
export async function sessionIdVisibleToRequest(ctx: RequestContext, sid: unknown): Promise<boolean> {
  return (await ctx.deps.sessions.sessionIdVisible(sid))
}

/** Pre-dispatch query guard for every `/api/` request (raw, SSE, and contract routes). */
export async function guardQuerySessionId(ctx: RequestContext): Promise<boolean> {
  const sid = ctx.query.get('session_id')
  if ((await sessionIdVisibleToRequest(ctx, sid))) {
    if (sid) ctx.query.set('session_id', await ctx.deps.sessions.resolveSessionId(sid))
    return true
  }
  if (ctx.method === 'GET' && ctx.path === '/api/session') return true
  await ctx.json({ error: 'Session not found' }, { status: 404 })
  return false
}

/** Contract-route guard for the parsed input (query or JSON body) of every procedure. */
export const requestSessionIdGuard = orpcBase.$context<ApiContext>().middleware(async ({ context: { ctx }, path, next }, input: unknown) => {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
  const sid = body?.session_id
  const visible = (await sessionIdVisibleToRequest(ctx, sid))
  if (!EXEMPT_PROCEDURES.has(path.join('.')) && !visible) throw new HttpError(404, 'Session not found')
  // Normalize once before handlers choose locks, runtime keys or files; an imported document keeps its own IDs.
  if (body && typeof sid === 'string' && visible && path.join('.') !== 'session.import') {
    body.session_id = await ctx.deps.sessions.resolveSessionId(sid)
  }
  return next()
})

/** Python `_stream_id_owner_session_id`: the live registry first, then the run journal once the run has finished. */
export async function streamOwnerSessionId(ctx: RequestContext, streamId: string): Promise<string | null> {
  const id = streamId.trim()
  if (!id) return null
  const live = ctx.deps.registry.ownerSessionId(id)
  if (live) return live
  if (!isSafeSessionId(id)) return null
  return (await ctx.deps.journal.findRunSummary(id))?.session_id || null
}

/** Python `_stream_id_visible_to_request_profile`: a stream is visible when its owner session is (or it has no known owner). */
export async function streamVisibleToRequest(ctx: RequestContext, streamId: string): Promise<boolean> {
  if (!ctx.deps.registry.visible(streamId.trim())) return false
  const owner = (await streamOwnerSessionId(ctx, streamId))
  return !owner || (await sessionIdVisibleToRequest(ctx, owner))
}
