import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from './cn'
import { motionOn, swapLabel } from '../lib/motion'

/**
 * A label whose text changes in place (TAL-1753): the old text fades out as the new fades in, in one slot that eases
 * between their widths, so what follows the label never snaps. Settled, it holds plain text and the caller's ellipsis
 * applies; only while the two lines swap is the slot a one-cell grid with both in it. `className` styles the slot.
 */
export function SwapText({ text, className, initialText, animate = true, fixed = false, id }: { text: string; className?: string | undefined; initialText?: string | undefined; animate?: boolean; fixed?: boolean; id?: string }) {
  const [view, setView] = useState({ text: initialText ?? text, out: null as string | null, swap: 0 })
  const enabled = animate && motionOn()
  if (view.text !== text || (!enabled && view.out !== null)) setView({ text, out: enabled ? view.text : null, swap: view.swap + 1 })
  const slot = useRef<HTMLSpanElement>(null)
  const { out, swap } = view
  useLayoutEffect(() => {
    const el = slot.current
    const incoming = el?.querySelector<HTMLElement>(':scope > [data-swap-in]')
    const outgoing = el?.querySelector<HTMLElement>(':scope > [data-swap-out]')
    if (!animate || !motionOn() || !el || !incoming || !outgoing) return
    const { animations, enter } = swapLabel(el, incoming, outgoing, fixed)
    // The new line lands last; the slot returns to plain text once it has.
    void enter.finished.then(() => { setView((v) => v.swap === swap ? { ...v, out: null } : v) }, () => undefined)
    return () => { for (const animation of animations) animation.cancel() }
  }, [swap, animate, fixed])
  const line = cn('col-start-1 row-start-1 whitespace-nowrap', fixed ? 'min-w-0 overflow-hidden text-ellipsis' : 'justify-self-start')
  return (
    <span ref={slot} id={id} className={cn(className, out !== null && (fixed ? 'grid overflow-hidden' : 'inline-grid overflow-hidden'))} data-swapping={out !== null || undefined}>
      {out !== null && <span key={`out:${swap}`} className={line} data-swap-out aria-hidden="true">{out}</span>}
      {out !== null ? <span key={`in:${swap}`} className={line} data-swap-in>{text}</span> : text}
    </span>
  )
}
