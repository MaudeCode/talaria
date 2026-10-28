/**
 * Session transcript state: the settled session (TanStack Query, windowed
 * loading with msg_limit/msg_before), plus reattachment to a run the server
 * reports as active. Teardown on session change releases the transport only.
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { invalidateSessionQueries } from '../../api/sessionQueries'
import { TRANSCRIPT_WINDOW } from '@maudecode/talaria-web-contracts'
import { SessionSchema, type Message, type Session } from '../../contracts'
import { attachToStream, hasLiveConnection, reconcileSession, discardSession, getStreamContext, teardown, useStreamContext } from '../../stream/connection'
import { getStreamState, useLiveTurn } from '../../stream/store'
import type { LiveTurn } from '../../stream/reducer'
import { openSessionStream } from '../../api/sse'
import { writePersisted } from '../../lib/persisted'

export { TRANSCRIPT_WINDOW } from '@maudecode/talaria-web-contracts'

export interface VisibleMessage {
  author?: string
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


export function useTranscript(sessionId: string | null, equalLive?: (previous: LiveTurn | null, next: LiveTurn | null) => boolean) {
  const qc = useQueryClient()
  const streamContext = useStreamContext()
  const query = useQuery({
    queryKey: keys.sessions.detail(sessionId ?? ''),
    queryFn: async ({ signal }) => {
      const sid = sessionId ?? ''
      const expectedStreamId = getStreamState().turns[sid]?.streamId
      try {
        const result = await api.fetchSession(sid, { messages: true, msg_limit: TRANSCRIPT_WINDOW }, signal)
        if (!signal.aborted) reconcileSession(sid, result.session, expectedStreamId)
        return result
      } catch (error) {
        if (!signal.aborted && error && typeof error === 'object' && 'status' in error && error.status === 404) discardSession(sid)
        throw error
      }
    },
    enabled: !!sessionId,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    retry: (count, error) => !(error instanceof Error && 'status' in error && (error as { status: number }).status === 404) && count < 1,
  })
  // The subscribed window; a moved boundary retires its prefix and pending pages together.
  const windowOffset = query.data?.session._messages_offset ?? 0
  const pageScope = ({ sessionId, windowOffset, streamContext })
  const [olderState, setOlderState] = useState<{ scope: typeof pageScope; items: Message[] }>({ scope: pageScope, items: [] })
  if (olderState.scope !== pageScope) setOlderState({ scope: pageScope, items: [] })
  const older = (olderState.scope === pageScope ? olderState.items : [])
  const setOlder = (update: (prev: Message[]) => Message[]) => setOlderState((s) => ({ scope: pageScope, items: update(s.scope === pageScope ? s.items : []) }))
  const [pageState, setPageState] = useState({ scope: pageScope, loading: false, error: false })
  if (pageState.scope !== pageScope) setPageState({ scope: pageScope, loading: false, error: false })
  const retiredPages = useRef(new WeakSet<object>())
  const paging = useRef<{ scope: typeof pageScope; loading: boolean; error: boolean; before?: number }>({ scope: pageScope, loading: false, error: false })
  useEffect(() => {
    const retired = retiredPages.current
    retired.delete(pageScope)
    return () => { retired.add(pageScope) }
  }, [pageScope])
  const loadingOlder = pageState.scope === pageScope && pageState.loading
  const olderError = pageState.scope === pageScope && pageState.error
  const attachedStream = useRef<string | null>(null)
  const session: Session | null = query.data?.session ?? null
  // Owners can change row metadata; reasoning visibility changes direct history too. Keep every loaded
  // page in the tail's invalidation family without dropping scroll history.
  const olderHistory = useQuery({
    queryKey: [...keys.sessions.detail(sessionId ?? ''), 'owner-history', windowOffset, older.length, session?.show_reasoning],
    queryFn: async ({ signal }) => {
      const start = Math.max(0, windowOffset - older.length)
      let before = windowOffset
      const chunks: Message[][] = []
      while (before > start) {
        const page = await api.fetchSession(sessionId ?? '', { messages: true, msg_limit: TRANSCRIPT_WINDOW, msg_before: before, resolve_model: false }, signal)
        const offset = page.session._messages_offset
        if (offset === undefined || offset >= before || !page.session.messages?.length) throw new Error('Owner history window changed')
        chunks.unshift(page.session.messages.slice(Math.max(0, start - offset), before - offset))
        before = offset
      }
      const refreshed = chunks.flat()
      if (refreshed.length !== older.length) throw new Error('Owner history window changed')
      return refreshed
    },
    enabled: !!sessionId && (!!session?.owner_attachment || session?.show_reasoning !== undefined) && older.length > 0,
    retry: false, refetchOnWindowFocus: false,
  })
  const live = useLiveTurn(sessionId, equalLive)

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

  useEffect(() => {
    if (!sessionId) return
    let retired = false
    let backgroundCompletion: string | null = null
    const scope = streamContext
    let initialized = false
    const cached = qc.getQueryData<{ session: Session }>(keys.sessions.detail(sessionId))
    const stream = openSessionStream(sessionId, { onEvent: ({ event, data }) => {
      if (retired || scope !== getStreamContext() || data.session_id !== sessionId) return
      if (event === 'initial') {
        const reconnect = initialized
        initialized = true
        if (!reconnect) return
      }
      const completion = JSON.stringify(data)
      const twin = event === 'process_complete' && completion === backgroundCompletion
      // The server emits the same completion under the current and legacy names, in that order.
      backgroundCompletion = event === 'bg_task_complete' ? completion : null
      if (!twin) {
        const filter = { queryKey: keys.sessions.detail(sessionId) }
        // Query invalidation alone reuses an in-flight first read when no data is cached.
        // Retire that pre-event snapshot before reading current owner metadata, including reactions.
        void qc.cancelQueries(filter).then(() => {
          if (!retired && scope === getStreamContext()) return qc.invalidateQueries(filter)
        })
      }
    } }, cached?.session.message_count)
    return () => { retired = true; stream.close() }
  }, [qc, sessionId, streamContext])

  // Passive exit: leaving the session releases the EventSource, never cancels the backend run.
  useEffect(() => {
    if (!sessionId) return
    return () => { teardown(sessionId) }
  }, [sessionId])

  const messages = (() => {
    const current = session?.messages ?? []
    return older.length ? [...(olderHistory.data ?? older), ...current] : current
  })()

  const base = Math.max(0, (session?._messages_offset ?? 0) - older.length)
  const rows = projectMessages(messages, base)
  const truncated = !!session?._messages_truncated && (session._messages_offset ?? 0) > older.length
  const loadOlder = async (retry = false, beforePrepend?: () => void) => {
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
    setPageState({ scope: pageScope, loading: true, error: false })
    const scope = getStreamContext()
    const current = () => !retiredPages.current.has(pageScope) && paging.current === request && scope === getStreamContext() && (qc.getQueryData<{ session: Session }>(keys.sessions.detail(sessionId))?.session._messages_offset ?? 0) === windowOffset
    try {
      const res = await api.fetchSession(sessionId, { messages: true, msg_limit: TRANSCRIPT_WINDOW, msg_before: before, resolve_model: false })
      const chunk = res.session.messages ?? []
      if (current() && !chunk.length) request.error = true
      else if (current()) {
        beforePrepend?.()
        setOlder((prev) => [...chunk, ...prev])
      }
    } catch {
      if (current()) request.error = true
    }
    request.loading = false
    if (current()) setPageState({ scope: pageScope, loading: false, error: request.error })
  }

  const refresh = async (accepted?: unknown, historyCut = false) => {
    if (accepted !== undefined || historyCut) {
      // Retire both the response and its admission/error state when history is replaced.
      paging.current = { scope: pageScope, loading: false, error: false }
      setPageState({ scope: pageScope, loading: false, error: false })
    }
    const scope = getStreamContext()
    const parsed = SessionSchema.safeParse(accepted)
    if (sessionId && parsed.success && parsed.data.session_id === sessionId && parsed.data.messages) {
      await qc.cancelQueries({ queryKey: keys.sessions.detail(sessionId) })
      if (scope !== getStreamContext()) return
      setOlder(() => [])
      discardSession(sessionId)
      qc.setQueryData(keys.sessions.detail(sessionId), { session: parsed.data })
      void invalidateSessionQueries(qc, sessionId, { detail: false })
      return
    }
    // Older/mutation row-only responses need a fresh authoritative transcript.
    if (accepted !== undefined || historyCut) setOlder(() => [])
    await qc.invalidateQueries({ queryKey: keys.sessions.detail(sessionId ?? '') })
  }

  return { query, session, rows, base, live, truncated, loadOlder, loadingOlder, olderError, refresh }
}
