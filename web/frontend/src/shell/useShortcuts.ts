import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toggleSidebarCollapsed } from './useShellState'
import { useNewChat } from '../features/sessions/useNewChat'

function inTextField(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null
  if (!t) return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}

/** Legacy global shortcuts: Cmd/Ctrl+B sidebar, Cmd/Ctrl+/ composer, Cmd/Ctrl+K new chat, Cmd/Ctrl+, settings. */
export function useShortcuts() {
  const navigate = useNavigate()
  const newChat = useNewChat()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return
      if (!e.shiftKey && (e.key === 'b' || e.key === 'B') && !inTextField(e.target) && window.matchMedia('(min-width: 641px)').matches) {
        e.preventDefault()
        toggleSidebarCollapsed()
      } else if (e.key === '/' && !inTextField(e.target)) {
        e.preventDefault()
        document.getElementById('msg')?.focus()
      } else if (e.key === 'k' && !inTextField(e.target)) {
        e.preventDefault()
        void newChat().then(() => document.getElementById('msg')?.focus())
      } else if (!e.shiftKey && e.key === ',') {
        e.preventDefault()
        void navigate({ to: '/settings' })
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, newChat])
}
