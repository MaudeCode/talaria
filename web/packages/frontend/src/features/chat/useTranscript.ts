/**
 * Session transcript state: the settled session (TanStack Query, windowed
 * loading with msg_limit/msg_before), plus reattachment to a run the server
 * reports as active. Teardown on session change releases the transport only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { Message, Session, ToolCall } from '../../contracts'
import { attachToStream, teardown } from '../../stream/connection'
import { useLiveTurn } from '../../stream/store'
import { isTerminal } from '../../stream/reducer'
import { writePersisted } from '../../lib/persisted'
import { messageText } from './render/text'

export const TRANSCRIPT_WINDOW = 120

export interface VisibleMessage {
  index: number
  message: Message
  key: string
  toolResults: Record<string, Message>
}

function isRenderable(msg: Message): boolean {
  if (!msg.role || msg.role === 'tool') return false
  const source = (msg as { _source?: string })._source
  if (source === 'process_wakeup') return !!(messageText(msg.content) || msg.attachments?.length)
  if ((msg as { _statusCard?: unknown })._statusCard) return true
  const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
  const hasReasoning = !!(msg.reasoning || msg.reasoning_content || msg.thinking)
  const text = messageText(msg.content)
  if (msg.role === 'assistant') return !!(text.trim() || hasTools || hasReasoning || msg.attachments?.length)
  return !!(text || msg.attachments?.length)
}

/**
 * Project raw messages into renderable rows; tool-role results attach to the owning assistant call by id.
 * `base` is the absolute index of `messages[0]` in the session (non-zero when only a window is loaded), so
 * `row.index` is always the position the truncate/branch `keep_count` contract expects.
 */
export function projectMessages(messages: Message[], base = 0): VisibleMessage[] {
  const results = new Map<string, Message>()
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const id = msg.tool_call_id ?? msg.tool_use_id
      if (id) results.set(id, msg)
    }
  }
  const rows: VisibleMessage[] = []
  messages.forEach((message, i) => {
    const index = base + i
    if (!isRenderable(message)) return
    const toolResults: Record<string, Message> = {}
    for (const tc of message.tool_calls ?? []) {
      const id = tc.id ?? tc.call_id ?? tc.tool_call_id
      const r = id ? results.get(id) : undefined
      if (id && r) toolResults[id] = r
    }
    rows.push({ index, message, key: messageKey(message) ?? `${index}-${message.role}`, toolResults })
  })
  return rows
}

export function toolCallId(tc: ToolCall, fallback: string): string {
  return tc.id ?? tc.call_id ?? tc.tool_call_id ?? fallback
}

/** Stable string id of a message (`message_id` wins; persisted rows carry integer `id`s). */
export function messageKey(message: Message): string | undefined {
  const raw = message.message_id ?? message.id
  return raw === undefined || raw === null ? undefined : String(raw)
}

/** Tool name and arguments, whichever shape the call was stored in. */
export function toolCallName(tc: ToolCall): string | undefined { return tc.name ?? tc.function?.name }
export function toolCallArgs(tc: ToolCall): unknown {
  if (tc.args !== undefined) return tc.args
  const raw = tc.function?.arguments
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

export function useTranscript(sessionId: string | null) {
  const qc = useQueryClient()
  const [olderState, setOlderState] = useState<{ sid: string | null; items: Message[] }>({ sid: sessionId, items: [] })
  const older = useMemo(() => (olderState.sid === sessionId ? olderState.items : []), [olderState, sessionId])
  const setOlder = useCallback((update: (prev: Message[]) => Message[]) => setOlderState((s) => ({ sid: sessionId, items: update(s.sid === sessionId ? s.items : []) })), [sessionId])
  const [loadingOlder, setLoadingOlder] = useState(false)
  const attachedStream = useRef<string | null>(null)
  const query = useQuery({
    queryKey: keys.sessions.detail(sessionId ?? ''),
    queryFn: () => api.fetchSession(sessionId ?? '', { messages: true, msg_limit: TRANSCRIPT_WINDOW }),
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
    if (live?.streamId === streamId && !isTerminal(live.status)) return
    if (attachedStream.current === streamId) return
    attachedStream.current = streamId
    void attachToStream(sessionId, streamId).catch(() => undefined)
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
  const loadOlder = useCallback(async () => {
    if (!sessionId || !session || loadingOlder) return
    const before = (session._messages_offset ?? 0) - older.length
    if (before <= 0) return
    setLoadingOlder(true)
    try {
      const res = await api.fetchSession(sessionId, { messages: true, msg_limit: TRANSCRIPT_WINDOW, msg_before: before, resolve_model: false })
      const chunk = res.session.messages ?? []
      setOlder((prev) => [...chunk, ...prev])
    } finally {
      setLoadingOlder(false)
    }
  }, [sessionId, session, older.length, loadingOlder, setOlder])

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: keys.sessions.detail(sessionId ?? '') }), [qc, sessionId])

  return { query, session, rows, live, truncated, loadOlder, loadingOlder, refresh }
}
