/**
 * Session transcript state: the settled session (TanStack Query, windowed
 * loading with msg_limit/msg_before), plus reattachment to a run the server
 * reports as active. Teardown on session change releases the transport only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { Message, Session } from '../../contracts'
import { attachToStream, hasLiveConnection, reconcileSession, discardSession, teardown } from '../../stream/connection'
import { getStreamState, useLiveTurn } from '../../stream/store'
import { writePersisted } from '../../lib/persisted'

export const TRANSCRIPT_WINDOW = 120

export interface VisibleMessage {
  index: number
  message: Message
  key: string
  assistantRows?: VisibleMessage[]
  turnKey?: string
}

/**
 * Project raw messages into the rows the server marks `_display: 'row'` (TAL-600); a row without the mark shows. A
 * settled turn's tools, results and steers arrive in its server scene.
 * `base` is the absolute index of `messages[0]` in the session (non-zero when only a window is loaded), so
 * `row.index` is always the position the truncate/branch `keep_count` contract expects.
 */
export function projectMessages(messages: Message[], base = 0): VisibleMessage[] {
  const rows: VisibleMessage[] = []
  messages.forEach((message, i) => {
    const index = base + i
    if ((message._display ?? 'row') !== 'row') return
    rows.push({ index, message, key: messageKey(message) ?? `${index}-${message.role}` })
  })
  return rows
}


/** Stable string id of a message (`message_id` wins; persisted rows carry integer `id`s). */
export function messageKey(message: Message): string | undefined {
  const raw = message.message_id ?? message.id
  return raw === undefined || raw === null ? undefined : String(raw)
}


export function useTranscript(sessionId: string | null) {
  const qc = useQueryClient()
  const [olderState, setOlderState] = useState<{ sid: string | null; items: Message[] }>({ sid: sessionId, items: [] })
  const older = useMemo(() => (olderState.sid === sessionId ? olderState.items : []), [olderState, sessionId])
  const setOlder = useCallback((update: (prev: Message[]) => Message[]) => setOlderState((s) => ({ sid: sessionId, items: update(s.sid === sessionId ? s.items : []) })), [sessionId])
  const [pageState, setPageState] = useState({ sid: sessionId, loading: false, error: false })
  if (pageState.sid !== sessionId) setPageState({ sid: sessionId, loading: false, error: false })
  const pageScope = useMemo(() => ({ sessionId }), [sessionId])
  const retiredPages = useRef(new WeakSet<object>())
  const paging = useRef<{ scope: typeof pageScope; loading: boolean; error: boolean; before?: number }>({ scope: pageScope, loading: false, error: false })
  useEffect(() => {
    const retired = retiredPages.current
    retired.delete(pageScope)
    return () => { retired.add(pageScope) }
  }, [pageScope])
  const loadingOlder = pageState.sid === sessionId && pageState.loading
  const olderError = pageState.sid === sessionId && pageState.error
  const attachedStream = useRef<string | null>(null)
  const query = useQuery({
    queryKey: keys.sessions.detail(sessionId ?? ''),
    queryFn: async ({ signal }) => {
      const sid = sessionId ?? ''
      const expectedStreamId = getStreamState().turns[sid]?.streamId
      try {
        const result = await api.fetchSession(sid, { messages: true, msg_limit: TRANSCRIPT_WINDOW })
        if (!signal.aborted) reconcileSession(sid, result.session, expectedStreamId)
        return result
      } catch (error) {
        if (!signal.aborted && error && typeof error === 'object' && 'status' in error && error.status === 404) discardSession(sid)
        throw error
      }
    },
    enabled: !!sessionId,
    staleTime: 5_000,
    retry: (count, error) => !(error instanceof Error && 'status' in error && (error as { status: number }).status === 404) && count < 1,
  })
  const session: Session | null = query.data?.session ?? null
  const live = useLiveTurn(sessionId)

  // Remember the last visible session (validated id) for the next boot.
  useEffect(() => {
    if (sessionId) writePersisted('hermes-webui-session', sessionId)
  }, [sessionId])

  useEffect(() => { attachedStream.current = null }, [sessionId])

  // Reattach to an active run the server reports (hard refresh, sidebar switch, restored tab).
  useEffect(() => {
    if (!sessionId || !session) return
    const streamId = session.active_stream_id
    if (!streamId) return
    if (live?.streamId === streamId && hasLiveConnection(sessionId)) return
    if (attachedStream.current === streamId) return
    attachedStream.current = streamId
    void attachToStream(sessionId, streamId, session).catch(() => undefined)
  }, [sessionId, session, live])

  // Passive exit: leaving the session releases the EventSource, never cancels the backend run.
  useEffect(() => {
    if (!sessionId) return
    return () => { teardown(sessionId) }
  }, [sessionId])

  const messages = useMemo(() => {
    const current = session?.messages ?? []
    return older.length ? [...older, ...current] : current
  }, [session, older])

  const base = Math.max(0, (session?._messages_offset ?? 0) - older.length)
  const rows = useMemo(() => projectMessages(messages, base), [messages, base])
  const truncated = !!session?._messages_truncated && (session._messages_offset ?? 0) > older.length
  const loadOlder = useCallback(async (retry = false, beforePrepend?: () => void) => {
    if (retiredPages.current.has(pageScope)) return
    if (paging.current.scope !== pageScope) paging.current = { scope: pageScope, loading: false, error: false }
    const request = paging.current
    if (!sessionId || !session || !truncated || request.loading || (request.error && !retry)) return
    const before = (session._messages_offset ?? 0) - older.length
    if (before <= 0) return
    if (request.before === before && !request.error) return
    request.before = before
    request.loading = true
    request.error = false
    setPageState({ sid: sessionId, loading: true, error: false })
    try {
      const res = await api.fetchSession(sessionId, { messages: true, msg_limit: TRANSCRIPT_WINDOW, msg_before: before, resolve_model: false })
      const chunk = res.session.messages ?? []
      if (retiredPages.current.has(pageScope) || paging.current !== request) return
      if (!chunk.length) throw new Error('Empty history page')
      beforePrepend?.()
      setOlder((prev) => [...chunk, ...prev])
    } catch {
      if (!retiredPages.current.has(pageScope) && paging.current === request) request.error = true
    } finally {
      request.loading = false
      if (!retiredPages.current.has(pageScope) && paging.current === request) setPageState({ sid: sessionId, loading: false, error: request.error })
    }
  }, [sessionId, session, truncated, older.length, setOlder, pageScope])

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: keys.sessions.detail(sessionId ?? '') }), [qc, sessionId])

  return { query, session, rows, base, live, truncated, loadOlder, loadingOlder, olderError, refresh }
}
