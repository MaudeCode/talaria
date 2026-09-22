import { useEffect } from 'react'
import { useSearch } from '@tanstack/react-router'

/** `?msg=<key>` deep link: scroll the matching row into view once the transcript renders. */
export function useSessionSearch(sessionId: string | null) {
  const search = useSearch({ strict: false })
  useEffect(() => {
    if (!sessionId || !search.msg) return
    const t = window.setTimeout(() => {
      const el = document.querySelector(`[data-message-key="${CSS.escape(search.msg ?? '')}"]`)
      el?.scrollIntoView({ block: 'center' })
    }, 300)
    return () => window.clearTimeout(t)
  }, [sessionId, search.msg])
}
