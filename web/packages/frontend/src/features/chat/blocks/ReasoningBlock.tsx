import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Lightbulb } from 'lucide-react'
import { cn } from '../../../ui/cn'
import { m } from '../../../paraglide/messages.js'
import { useDisclosure } from './Worklog'
import { SwapText } from '../../../ui/SwapText'
import { useArrival } from '../arrival'

/**
 * Reasoning / thinking on the legacy `.thinking-card` markup. Collapsed by default; a live block shows the latest title.
 * `disclosureKey` is the server's segment identity (TAL-1175): the live card and its settled row share one disclosure, as
 * tool cards do. Old-server fallback: a card without one keeps its own state; delete it once every server sends the key.
 */
export function ReasoningBlock({ text, titles, disclosureKey, live = false, defaultOpen = false, arrivalKey }: { text: string; titles?: string[] | undefined; disclosureKey?: string | undefined; live?: boolean; defaultOpen?: boolean; /** Its row in a running turn, which opens as it arrives. */ arrivalKey?: string | undefined }) {
  const arrival = useArrival(arrivalKey)
  const [shared, toggleShared] = useDisclosure(`reasoning:${disclosureKey ?? ''}`, defaultOpen)
  const [local, setLocal] = useState(defaultOpen)
  const open = disclosureKey ? shared : local
  const toggle = disclosureKey ? toggleShared : () => { setLocal((o) => !o) }
  const clean = text.trim()
  const hasText = clean.length > 0
  const body = useRef<HTMLDivElement>(null)
  const intent = useRef({ following: true, top: 0 })
  useLayoutEffect(() => { intent.current = { following: true, top: 0 } }, [disclosureKey, arrivalKey, live])
  useLayoutEffect(() => {
    const el = body.current
    if (!live || !open || !hasText || !el) return
    const reader = intent.current
    let active = true
    let lastTop = 0
    let restoring = true
    const onScroll = () => {
      if (restoring) return
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      const top = Math.max(0, Math.min(el.scrollTop, max))
      // Our own jump's event can arrive after growth; only an upward move leaves follow mode.
      if (max - top <= 2) reader.following = true
      else if (top < Math.min(lastTop, max)) reader.following = false
      reader.top = lastTop = top
    }
    const follow = () => {
      if (!active || el.clientHeight === 0) return
      // A parent disclosure may still be hidden when this body mounts. Restore intent once it has geometry.
      if (restoring) { el.scrollTop = reader.top; lastTop = el.scrollTop; restoring = false }
      // A reader's scroll can reach the DOM before its event, including during opening layout.
      if (el.scrollTop !== lastTop) onScroll()
      if (reader.following) el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
      reader.top = lastTop = el.scrollTop
    }
    follow()
    el.addEventListener('scroll', onScroll)
    const observer = new ResizeObserver(follow)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => { active = false; observer.disconnect(); el.removeEventListener('scroll', onScroll) }
  }, [live, open, hasText, disclosureKey, arrivalKey])
  const latest = titles?.[titles.length - 1]
  if (!clean && !live && !latest) return null
  return (
    <div ref={arrival} className={cn('thinking-card', open && 'open', live && 'thinking-card-live')} data-live={live ? '1' : undefined} data-reasoning-active={live ? '1' : undefined}>
      <div className="thinking-card-head-row">
        <button type="button" className="thinking-card-header" aria-expanded={open} onClick={toggle}>
          <span className="thinking-card-icon"><Lightbulb size={14} aria-hidden="true" /></span>
          <SwapText className="thinking-card-label" text={latest ?? (live ? m.voice_thinking() : m.thinking_label())} />
          <span className="thinking-card-toggle" aria-hidden="true"><ChevronRight size={12} /></span>
        </button>
      </div>
      {open && clean && <div ref={body} className="thinking-card-body"><pre>{clean}</pre></div>}
    </div>
  )
}
