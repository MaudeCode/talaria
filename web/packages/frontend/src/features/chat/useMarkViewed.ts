/**
 * Tell the server this tab showed a session's latest turn, so the relay clears
 * its finished runs from the phone's Live Activities (TAL-438). Fires once the
 * transcript comes from the server, again when a run in the open session ends,
 * and on every return to a visible tab; hidden tabs and cached boot snapshots
 * never count as viewing. The server stamps the viewed instant.
 */
import { useEffect } from 'react'
import * as api from '../../api/endpoints'

export function useMarkViewed(sessionId: string | null, loaded: boolean, endedStreamId: string | null): void {
  useEffect(() => {
    if (!sessionId || !loaded) return
    const mark = (): void => {
      if (document.visibilityState === 'visible') void api.markSessionViewed(sessionId).catch(() => undefined)
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => { document.removeEventListener('visibilitychange', mark) }
  }, [sessionId, loaded, endedStreamId])
}
