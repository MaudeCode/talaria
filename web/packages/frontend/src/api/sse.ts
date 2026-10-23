/**
 * The only module that constructs `EventSource`. Frames are parsed and
 * validated with the chat SSE union before anything else sees them.
 */
import { parseChatEvent, type ChatEvent, SessionListEventSchema, type SessionListEvent, CHAT_EVENT_NAMES, SESSION_STREAM_EVENT_NAMES, SessionStreamEventSchema, type SessionStreamEvent } from '../contracts/sse'
import { resolveApiUrl } from './client'

export interface SseHandle {
  close(): void
  readonly readyState: () => number
}

export interface ChatStreamCallbacks {
  onEvent: (event: ChatEvent, lastEventId: string) => void
  onOpen?: () => void
  onError?: (readyState: number) => void
  onUnknown?: (name: string, data: string) => void
}

export function openChatStream(streamId: string, replay: { afterSeq: number; afterEventId: string } | null, cb: ChatStreamCallbacks): SseHandle {
  const params = new URLSearchParams({ stream_id: streamId })
  if (replay) {
    params.set('replay', '1')
    params.set('after_seq', String(replay.afterSeq))
    params.set('after_event_id', replay.afterEventId)
  }
  const source = new EventSource(resolveApiUrl(`api/chat/stream?${params.toString()}`).href, { withCredentials: true })
  const listener = (name: string) => (ev: Event) => {
    const me = ev as MessageEvent<string>
    const parsed = parseChatEvent(name, typeof me.data === 'string' ? me.data : '')
    if (parsed) cb.onEvent(parsed, me.lastEventId)
    else cb.onUnknown?.(name, me.data)
  }
  for (const name of CHAT_EVENT_NAMES) source.addEventListener(name, listener(name))
  source.onopen = () => cb.onOpen?.()
  source.onerror = () => cb.onError?.(source.readyState)
  return { close: () => source.close(), readyState: () => source.readyState }
}

interface SessionFeedCallbacks<T> {
  onEvent: (event: T) => void
  onError?: (readyState: number) => void
  onOpen?: () => void
}

function openSessionFeed<T>(path: string, names: readonly string[], parse: (value: unknown) => { success: boolean; data?: T }, cb: SessionFeedCallbacks<T>): SseHandle {
  const source = new EventSource(resolveApiUrl(path).href, { withCredentials: true })
  for (const name of names) {
    source.addEventListener(name, (ev: Event) => {
      const me = ev as MessageEvent<string>
      let data: unknown
      try { data = me.data ? JSON.parse(me.data) as unknown : {} }
      catch { return }
      const parsed = parse({ event: name, data })
      if (parsed.success && parsed.data) cb.onEvent(parsed.data)
    })
  }
  source.onopen = () => cb.onOpen?.()
  source.onerror = () => cb.onError?.(source.readyState)
  return { close: () => source.close(), readyState: () => source.readyState }
}

export function openSessionListStream(cb: SessionFeedCallbacks<SessionListEvent>): SseHandle {
  return openSessionFeed('api/sessions/events?gateway=1', ['initial', 'sessions_changed', 'gateway_status', 'hello'], (value) => SessionListEventSchema.safeParse(value), cb)
}

export function openSessionStream(sessionId: string, cb: SessionFeedCallbacks<SessionStreamEvent>, knownCount?: number): SseHandle {
  const params = new URLSearchParams({ session_id: sessionId })
  if (knownCount !== undefined) params.set('known_count', String(knownCount))
  return openSessionFeed(`api/session/stream?${params.toString()}`, SESSION_STREAM_EVENT_NAMES, (value) => SessionStreamEventSchema.safeParse(value), cb)
}

export const SSE_CONNECTING = 0
export const SSE_OPEN = 1
export const SSE_CLOSED = 2

export interface TerminalStreamCallbacks {
  onOutput: (text: string) => void
  onClosed: () => void
  onError: (message: string | null) => void
}

/** Workspace terminal output: `output` frames carry `{text}`, `terminal_closed` / `terminal_error` end the stream. */
export function openTerminalStream(sessionId: string, cb: TerminalStreamCallbacks): SseHandle {
  const source = new EventSource(resolveApiUrl(`api/terminal/output?session_id=${encodeURIComponent(sessionId)}`).href, { withCredentials: true })
  const data = (ev: Event): Record<string, unknown> => { try { return JSON.parse((ev as MessageEvent<string>).data) as Record<string, unknown> } catch { return {} } }
  source.addEventListener('output', (ev) => { const text = data(ev).text; if (typeof text === 'string' && text) cb.onOutput(text) })
  source.addEventListener('terminal_closed', () => { source.close(); cb.onClosed() })
  source.addEventListener('terminal_error', (ev) => { const err = data(ev).error; source.close(); cb.onError(typeof err === 'string' ? err : null) })
  return { close: () => source.close(), readyState: () => source.readyState }
}

/** Kanban task events (`/api/kanban/events/stream`) on `board` after `since`; `onEvents` fires once per non-empty batch. */
export function openKanbanEventStream(board: string | undefined, since: number, onEvents: () => void): SseHandle {
  const params = new URLSearchParams({ since: String(since), ...(board ? { board } : {}) })
  const source = new EventSource(resolveApiUrl(`api/kanban/events/stream?${params.toString()}`).href, { withCredentials: true })
  source.addEventListener('events', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent<string>).data) as { events?: unknown }
      if (Array.isArray(data.events) && data.events.length) onEvents()
    } catch { /* a malformed frame is skipped; the next batch still refreshes */ }
  })
  return { close: () => source.close(), readyState: () => source.readyState }
}
