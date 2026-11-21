import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Quote } from 'lucide-react'
import { MAX_QUOTE_LENGTH } from '../composer/composerReturn'
import { Button } from '../../ui/Button'
import { m } from '../../paraglide/messages.js'
import { getStreamContext } from '../../stream/connection'

const GAP = 8

/**
 * The action's place in the transcript shell: under the end of the selection, above it when the composer or the
 * pane's bottom is in the way, and clamped inside the visible pane. Null once the selection's end line has left it.
 */
function placeAction(range: Range, pane: HTMLElement, action: HTMLElement | null): { left: number; top: number } | null {
  const lines = range.getClientRects()
  const end = lines[lines.length - 1] ?? range.getBoundingClientRect()
  const box = pane.getBoundingClientRect()
  // The docked composer overlays the pane's bottom; ChatView measures it into --composer-h.
  const bottom = box.bottom - (parseFloat(getComputedStyle(pane).getPropertyValue('--composer-h')) || 0)
  if (end.bottom < box.top || end.top > bottom) return null
  const width = action?.offsetWidth ?? 0, height = action?.offsetHeight ?? 0
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))
  const below = end.bottom + GAP
  const top = below + height <= bottom - GAP ? below : end.top - GAP - height
  return {
    left: clamp(end.right - width / 2, box.left + GAP, box.right - GAP - width) - box.left + pane.offsetLeft,
    top: clamp(top, box.top + GAP, bottom - GAP - height) - box.top + pane.offsetTop,
  }
}

/** One selection action for every transcript renderer; native selection and link gestures stay browser-owned. */
export function QuoteSelection({ transcript, onQuote }: { transcript: RefObject<HTMLDivElement | null>; onQuote: (text: string) => void }) {
  const button = useRef<HTMLButtonElement>(null)
  const [selected, setSelected] = useState<{ text: string; raw: string; range: Range; context: object } | null>(null)
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection()
      // Keyboard focus can collapse the browser range as Tab reaches the quote action.
      if (document.activeElement === button.current) return
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) { setSelected(null); return }
      const range = selection.getRangeAt(0)
      const body = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('.msg-body')
      const start = body(range.startContainer)
      const text = selection.toString()
      if (!start || start !== body(range.endContainer) || !transcript.current?.contains(start) || !text.trim() || text.length > MAX_QUOTE_LENGTH) {
        setSelected(null)
        return
      }
      setSelected({ text, raw: range.toString(), range: range.cloneRange(), context: getStreamContext() })
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [transcript])
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const range = selected?.range
  useLayoutEffect(() => {
    const pane = transcript.current
    if (!range || !pane) return
    const place = () => setAt(placeAction(range, pane, button.current))
    place()
    pane.addEventListener('scroll', place, { passive: true })
    // The pane also resizes without a window resize, as when the side panel is dragged.
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    resize?.observe(pane)
    return () => { pane.removeEventListener('scroll', place); resize?.disconnect() }
  }, [range, transcript])
  if (!selected) return null
  return <Button
    ref={button}
    // Hidden, not removed, so the action keeps a size to place by and leaves the tab order and accessibility tree.
    style={at ?? { visibility: 'hidden' }}
    className="absolute z-10 min-h-11"
    onPointerDown={(event) => event.preventDefault()}
    onBlur={() => setSelected(null)}
    onKeyDown={(event) => { if (event.key === 'Escape') { setSelected(null); window.getSelection()?.removeAllRanges() } }}
    onClick={() => {
      const { range, raw, text, context } = selected
      if (context === getStreamContext() && transcript.current?.contains(range.startContainer) && transcript.current.contains(range.endContainer) && range.toString() === raw) onQuote(text)
      setSelected(null)
    }}
  ><Quote size={14} aria-hidden="true" />{m.quote_selection()}</Button>
}
