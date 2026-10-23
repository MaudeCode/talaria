import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { keys } from '../../api/queryKeys'
import { invalidateSessionQueries } from '../../api/sessionQueries'
import { getStreamState, hasRecentTerminalSession } from '../../stream/store'
import { getStreamContext, useStreamContext, hasLiveConnection } from '../../stream/connection'
import { openSessionListStream, SSE_OPEN } from '../../api/sse'
import { useSetting } from '../../app/settings'
import { deliverCompletion } from '../voice/completionAudio'

/**
 * TAL-1209: refetch the sidebar rows (list and search) and every query of the named session; other sessions' transcripts,
 * status, and background work stay cached, so a run's event stream does not refetch every mounted session.
 */
function invalidateSidebar(qc: QueryClient, sessionId?: string | null, reason?: string) {
  const cachedTerminal = !!sessionId && hasRecentTerminalSession(sessionId) && !!qc.getQueryData(keys.sessions.detail(sessionId))
  // The sidebar can arrive first; a followed run supplies its snapshot or reconciles on stream loss.
  const awaitingTerminal = !!sessionId && reason === 'session_done' && hasLiveConnection(sessionId) && getStreamState().turns[sessionId]?.doneAt === null
  void invalidateSessionQueries(qc, sessionId, { detail: !cachedTerminal && !awaitingTerminal })
}

/** One global event feed per authenticated tab, including playback while another page is open. */
export function useSessionListStream() {
  const qc = useQueryClient()
  const sound = useSetting('sound_enabled') === true
  const context = useStreamContext()
  useEffect(() => {
    let closed = false
    const scope = getStreamContext()
    let handle = openSessionListStream({
      onEvent: (ev) => {
        if (closed || scope !== getStreamContext()) return
        if (ev.event === 'sessions_changed') {
          for (const completion of ev.data.web_audio ?? []) void deliverCompletion(completion, () => !closed && sound && scope === getStreamContext())
          if (ev.data.session_id) invalidateSidebar(qc, ev.data.session_id, ev.data.reason)
          // No id (a delete, an import, or two sessions' events coalesced): any session may have changed.
          else void qc.invalidateQueries({ queryKey: keys.sessions.all })
        }
        else if (ev.event === 'initial') invalidateSidebar(qc)
      },
      onError: () => { /* EventSource retries on its own; the poll below covers long outages */ },
    })
    const poll = window.setInterval(() => { if (!closed && handle.readyState() !== SSE_OPEN && document.visibilityState === 'visible') invalidateSidebar(qc) }, 60_000)
    return () => {
      closed = true
      handle.close()
      handle = { close: () => undefined, readyState: () => 2 }
      window.clearInterval(poll)
    }
  }, [qc, sound, context])
}
