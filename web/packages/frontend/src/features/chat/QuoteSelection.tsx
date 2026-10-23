import { useEffect, useRef, useState, type RefObject } from 'react'
import { Quote } from 'lucide-react'
import { MAX_QUOTE_LENGTH } from '../composer/composerReturn'
import { Button } from '../../ui/Button'
import { m } from '../../paraglide/messages.js'
import { getStreamContext } from '../../stream/connection'

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
  if (!selected) return null
  return <Button
    onFocus={(event) => { button.current = event.currentTarget }}
    className="absolute left-5 top-2 z-10 min-h-11"
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
