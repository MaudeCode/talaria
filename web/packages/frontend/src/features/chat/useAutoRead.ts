import { useContext, useEffect, useRef } from 'react'
import type { LiveTurn } from '../../stream/reducer'
import { isTerminal } from '../../stream/reducer'
import { claimAutomaticSpeech, speak } from '../voice/tts'
import { BootstrapContext } from '../../app/bootstrap'
import { appRoot } from '../../lib/appRoot'
import { getStreamContext } from '../../stream/connection'
import { activityText, isReplyRow, persistedActivity } from './turnActivity'
import type { VisibleMessage } from './useTranscript'

/**
 * Auto-read (`tts_auto_read`): speak a reply this view watched run, once, from the server's persisted scene.
 * `settled`: the live turn has handed over to the server rows. A turn that ended before the view saw it run stays quiet.
 */
export function useAutoRead(enabled: boolean, rows: VisibleMessage[], live: LiveTurn | null, settled: boolean): void {
  const watched = useRef(new Set<string>())
  const spoken = useRef(new Set<string>())
  const bootstrap = useContext(BootstrapContext)
  const scope = bootstrap ? JSON.stringify([appRoot().href, bootstrap.auth.auth_type ?? null, bootstrap.auth.user ?? null, bootstrap.profile?.name ?? 'default', live?.sessionId]) : null
  const streamId = live?.streamId
  const status = live?.status
  const turnId = live?.turnId ?? streamId
  const row = rows.findLast((r) => isReplyRow(r.message) && (r.turnKey === streamId || r.turnKey === turnId))
  const text = row ? activityText(persistedActivity(row)) : ''
  useEffect(() => {
    if (!scope || !streamId || !status || !turnId) return
    const key = JSON.stringify([scope, turnId])
    const watchedKey = JSON.stringify([scope, streamId])
    if (!isTerminal(status)) { watched.current.add(watchedKey); return }
    if (!enabled || !settled || status !== 'done' || !watched.current.has(watchedKey) || spoken.current.has(key)) return
    if (!text.trim()) return
    spoken.current.add(key)
    let cancelled = false
    const context = getStreamContext()
    void claimAutomaticSpeech(key).then((owned) => {
      if (owned && !cancelled && context === getStreamContext()) return speak(text)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [enabled, scope, streamId, turnId, status, text, settled])
}
