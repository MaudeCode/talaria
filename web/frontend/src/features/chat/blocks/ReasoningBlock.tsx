import { useState } from 'react'
import { ChevronRight, Lightbulb } from 'lucide-react'
import { cn } from '../../../ui/cn'
import { m } from '../../../paraglide/messages.js'
import { stripToolCallXml } from '../render/text'

/** Reasoning / thinking on the legacy `.thinking-card` markup. Collapsed by default; a live block shows the latest title. */
export function ReasoningBlock({ text, titles, live = false, defaultOpen = false }: { text: string; titles?: string[] | undefined; live?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const clean = stripToolCallXml(text).trim()
  const latest = titles?.[titles.length - 1]
  if (!clean && !live && !latest) return null
  return (
    <div className={cn('thinking-card', open && 'open', live && 'thinking-card-live')} data-live={live ? '1' : undefined}>
      <div className="thinking-card-head-row">
        <button type="button" className="thinking-card-header" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="thinking-card-icon"><Lightbulb size={14} aria-hidden="true" /></span>
          <span className="thinking-card-label">{latest ?? (live ? m.voice_thinking() : m.thinking_label())}</span>
          <span className="thinking-card-toggle" aria-hidden="true"><ChevronRight size={12} /></span>
        </button>
      </div>
      {open && clean && <div className="thinking-card-body"><pre>{clean}</pre></div>}
    </div>
  )
}
