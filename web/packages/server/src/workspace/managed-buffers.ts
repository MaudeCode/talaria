/** Native managed files share the Files procedures, but never resolve a workspace or client-supplied native path. */
import { MAX_MANAGED_BUFFER_BYTES } from '@maudecode/talaria-web-contracts'
import { createHmac } from 'node:crypto'
import type { RequestContext } from '../http/context.js'
import { HttpError } from '../api/router.js'
import { isSafeSessionId, type Session } from '../sessions/session.js'
import { stateDbSessionReadAsync } from '../sessions/state-db.js'
import { SidecarError } from '../sidecar/client.js'

/** Shared identity check for both file sources, before either chooses its own storage. */
export async function fileSourceSession(ctx: RequestContext, sid: string) {
  let session: Session
  try { session = await ctx.deps.sessionStore.get(sid, { metadataOnly: true }) }
  catch {
    const profile = ctx.deps.activeProfile()
    if (!ctx.deps.sessions.personMaySee(null) || !isSafeSessionId(sid) || !await stateDbSessionReadAsync(false, 'stateDbHasSession', ctx.deps.cliSessions.dbPath(profile), sid)) throw new HttpError(404, 'Session not found')
    return { session: null, profile }
  }
  if (!ctx.deps.sessions.visibleToRequest(session)) throw new HttpError(404, 'Session not found')
  return { session, profile: session.profile }
}

export async function managedBuffers(ctx: RequestContext, input: { session_id: string; path?: string | undefined; content?: string | undefined }, action: 'list' | 'read' | 'save') {
  const profile = ctx.deps.activeProfile()
  const { session } = await fileSourceSession(ctx, input.session_id)
  const home = ctx.deps.profileHome(profile)
  const readOnly = (session ? await ctx.deps.sessions.isReadOnly(session) : await ctx.deps.sessions.readOnlyReason(input.session_id) !== null) || await ctx.deps.sessions.isSubagentViewOnly(input.session_id)
  const sc = ctx.deps.sidecar()
  if (sc?.status !== 'ready') {
    if (action === 'list') return { source: 'managed' as const, entries: [], unavailable: true, read_only: true, write_semantics: 'unconditional' as const }
    throw new HttpError(503, 'Managed buffer backend unavailable')
  }
  const id = (name: string) => 'buffer-' + createHmac('sha256', ctx.deps.auth.signingKey()).update(JSON.stringify([home, input.session_id, name])).digest('hex')
  const call = async (operation: 'list' | 'read' | 'save', name?: string) => {
    try {
      return await sc.call('plugins.buffers', { profile_home: home, session_id: input.session_id, action: operation, ...(name ? { name } : {}), ...(operation === 'save' ? { content: input.content ?? '' } : {}) })
    } catch (error) {
      if (error instanceof SidecarError && operation !== 'save' && error.code === -32601) return { supported: false, buffers: [], write_semantics: 'unconditional' as const }
      if (operation === 'save') throw new HttpError(503, 'Save outcome is unknown. Reload before retrying.', { condition: 'buffer_save_unconfirmed' })
      throw new HttpError(503, 'Managed buffer backend unavailable')
    }
  }
  const list = await call('list')
  const entries = list.buffers.map((b) => ({ name: b.name, path: id(b.name), size: b.size, is_dir: false, type: 'file', read_only: readOnly || b.read_only }))
  if (action === 'list') return { source: 'managed' as const, entries, unavailable: !list.supported, read_only: readOnly, write_semantics: list.write_semantics }
  const selected = entries.find((b) => b.path === input.path)
  if (!list.supported || !selected) throw new HttpError(404, 'Managed buffer no longer exists')
  if (action === 'save' && selected.read_only) throw new HttpError(403, 'Managed buffer is read-only')
  if (action === 'save' && Buffer.byteLength(input.content ?? '', 'utf8') > MAX_MANAGED_BUFFER_BYTES) throw new HttpError(413, 'Managed buffer is too large')
  if (action === 'save') {
    // Inventory is asynchronous; ownership may have changed since the displayed permission was computed.
    if (await ctx.deps.sessions.isSubagentViewOnly(input.session_id)) throw new HttpError(403, 'Managed buffer is read-only')
    await ctx.deps.sessions.assertWritable(input.session_id)
  }
  const value = await call(action, selected.name)
  if (action === 'save') {
    if (!value.supported || value.size === undefined) throw new HttpError(503, 'Save outcome is unknown. Reload before retrying.', { condition: 'buffer_save_unconfirmed' })
    return { source: 'managed' as const, ok: true as const, path: selected.path, size: value.size }
  }
  if (!value.supported || value.content === undefined) throw new HttpError(404, 'Managed buffer no longer exists')
  // Plain text avoids active HTML/Markdown interpretation of backend-owned buffers.
  return { source: 'managed' as const, path: input.path, name: selected.name, content: value.content, size: value.size, preview: 'text' as const, read_only: readOnly || value.read_only !== false, write_semantics: value.write_semantics }
}
