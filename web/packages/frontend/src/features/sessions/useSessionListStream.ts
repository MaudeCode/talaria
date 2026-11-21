import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { keys } from '../../api/queryKeys'
import { invalidateSessionQueries, isSessionListKey } from '../../api/sessionQueries'
import { getStreamState, hasRecentTerminalSession } from '../../stream/store'
import { getStreamContext, useStreamContext, hasLiveConnection } from '../../stream/connection'
import { openSessionListStream, SSE_CLOSED, SSE_OPEN, type SseHandle } from '../../api/sse'
import { useSetting } from '../../app/settings'
import { deliverCompletion } from '../voice/completionAudio'
import { notifyCompletion, pushEndpoint } from '../notifications/completionNotification'

/**
 * TAL-1209: refetch every query of the named session; other sessions' transcripts, status, and background work stay
 * cached, so a run's event stream does not refetch every mounted session. The sidebar rows follow `pacedListRefresh`.
 */
function invalidateSession(qc: QueryClient, sessionId: string, reason?: string) {
  const cachedTerminal = hasRecentTerminalSession(sessionId) && !!qc.getQueryData(keys.sessions.detail(sessionId))
  // The sidebar can arrive first; a followed run supplies its snapshot or reconciles on stream loss.
  const awaitingTerminal = reason === 'session_done' && hasLiveConnection(sessionId) && getStreamState().turns[sessionId]?.doneAt === null
  void invalidateSessionQueries(qc, sessionId, { detail: !cachedTerminal && !awaitingTerminal, list: false })
}

const LIST_BURST_MS = 300
const LIST_CADENCE_MS = 5_000

/**
 * TAL-2261: stream events refresh the sidebar rows (list and search) 300 ms after a quiet start, then at most once per
 * 5 s, with one trailing read for events since the last one. A read in flight finishes before the next starts, so a
 * slow list is neither restarted nor stacked. Only timers pace it, so a wall-clock step cannot stall it. Direct
 * mutations call `invalidateSessionQueries` and skip this pacing.
 */
function pacedListRefresh(qc: QueryClient) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false, cooling = false, reading = false, dirty = false
  const read = () => {
    if (closed || cooling || reading || !dirty) return
    dirty = false
    reading = cooling = true
    timer = setTimeout(() => { timer = undefined; cooling = false; read() }, LIST_CADENCE_MS)
    void invalidateSessionQueries(qc).finally(() => { reading = false; read() })
  }
  return {
    request: () => {
      dirty = true
      if (!cooling && !reading && timer === undefined) timer = setTimeout(() => { timer = undefined; read() }, LIST_BURST_MS)
    },
    close: () => { closed = true; clearTimeout(timer) },
  }
}

/** One global event feed per authenticated tab, including playback while another page is open. */
export function useSessionListStream() {
  const qc = useQueryClient()
  const sound = useSetting('sound_enabled') === true
  const notify = useSetting('notifications_enabled') === true
  const context = useStreamContext()
  useEffect(() => {
    let closed = false
    const scope = getStreamContext()
    const list = pacedListRefresh(qc)
    let handle: SseHandle = { close: () => undefined, readyState: () => SSE_CLOSED }
    // TAL-2478: the stream names this browser's Web Push endpoint, so each completion says whether Web Push shows it here.
    const open = (endpoint: string | undefined) => { if (!closed) handle = openSessionListStream({
      onEvent: (ev) => {
        if (closed || scope !== getStreamContext()) return
        if (ev.event === 'sessions_changed') {
          for (const completion of ev.data.web_audio ?? []) {
            void deliverCompletion(completion, () => !closed && sound && scope === getStreamContext())
            void notifyCompletion(completion, () => !closed && notify && scope === getStreamContext())
          }
          // TAL-1966: a review that opened or closed changes the Decisions list.
          if (ev.data.reason === 'decision_review') void qc.invalidateQueries({ queryKey: keys.decisionReviews })
          if (ev.data.session_id) invalidateSession(qc, ev.data.session_id, ev.data.reason)
          // No id (a delete, an import, or two sessions' events coalesced): any session may have changed.
          else void qc.invalidateQueries({ queryKey: keys.sessions.all, predicate: ({ queryKey }) => !isSessionListKey(queryKey) })
          list.request()
        }
        else if (ev.event === 'initial') list.request()
      },
      onError: () => { /* EventSource retries on its own; the poll below covers long outages */ },
    }, endpoint) }
    void pushEndpoint().then(open)
    const poll = window.setInterval(() => { if (!closed && handle.readyState() !== SSE_OPEN && document.visibilityState === 'visible') void invalidateSessionQueries(qc) }, 60_000)
    return () => {
      closed = true
      list.close()
      handle.close()
      handle = { close: () => undefined, readyState: () => SSE_CLOSED }
      window.clearInterval(poll)
    }
  }, [qc, sound, notify, context])
}
