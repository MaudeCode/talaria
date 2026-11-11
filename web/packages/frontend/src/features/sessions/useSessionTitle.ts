import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { keys } from '../../api/queryKeys'
import type { fetchSession, fetchSessions } from '../../api/endpoints'
import { m } from '../../paraglide/messages.js'
import { useResourceEffects } from './useResourceMutation'

/** Both chat headers observe the transcript/list caches; this never starts a second session read. */
export function useSessionTitle(sessionId: string | null, fallback: string) {
  const detail = useQuery<Awaited<ReturnType<typeof fetchSession>>, Error, string | undefined>({ queryKey: keys.sessions.detail(sessionId ?? ''), enabled: false, select: (data) => data.session.title })
  const list = useQuery<Awaited<ReturnType<typeof fetchSessions>>, Error, string | undefined>({ queryKey: keys.sessions.list({}), enabled: false, select: (data) => data.sessions.find((row) => row.session_id === sessionId)?.title })
  const effects = useResourceEffects()
  const title = effects[`session:${sessionId}`]?.fields?.title ?? detail.data ?? list.data
  return typeof title === 'string' ? title || m.untitled() : fallback
}

/** Remounted chats carry only the previous title and entrance intent, never the previous chat's working state. */
export function useChatSwitch(sessionId: string | null, title: string) {
  const [view, setView] = useState({ sessionId, title, from: null as string | null })
  if (view.sessionId !== sessionId) {
    const next = { sessionId, title, from: view.sessionId && sessionId ? view.title : null }
    setView(next)
    return next.from
  }
  if (view.title !== title) setView({ ...view, title })
  return view.from
}
