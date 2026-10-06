import { useEffect, useRef } from 'react'
import type { LiveTurn } from '../../stream/reducer'
import { isTerminal } from '../../stream/reducer'
import { speak } from '../voice/tts'
import { activityText, persistedActivity } from './turnActivity'
import type { VisibleMessage } from './useTranscript'

/**
 * Auto-read (`tts_auto_read`): speak a reply this view watched run, once, from the server's persisted scene.
 * `settled`: the live turn has handed over to the server rows. A turn that ended before the view saw it run stays quiet.
 */
export function useAutoRead(enabled: boolean, rows: VisibleMessage[], live: LiveTurn | null, settled: boolean): void {
  const watched = useRef(new Set<string>())
  const spoken = useRef(new Set<string>())
  useEffect(() => {
    if (!live) return
    if (!isTerminal(live.status)) { watched.current.add(live.streamId); return }
    if (!enabled || !settled || live.status !== 'done' || !watched.current.has(live.streamId) || spoken.current.has(live.streamId)) return
    const row = rows.findLast((r) => r.message.role === 'assistant' && !r.message._marker_kind && (r.turnKey === live.streamId || r.turnKey === live.turnId))
    const text = row ? activityText(persistedActivity(row)) : ''
    if (!text.trim()) return
    spoken.current.add(live.streamId)
    void speak(text).catch(() => undefined)
  }, [enabled, rows, live, settled])
}
