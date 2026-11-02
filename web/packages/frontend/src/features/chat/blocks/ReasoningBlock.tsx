import { useState } from 'react'
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
      {open && clean && <div className="thinking-card-body"><pre>{clean}</pre></div>}
    </div>
  )
}
