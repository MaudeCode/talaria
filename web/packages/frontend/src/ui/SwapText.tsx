import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from './cn'
import { ARRIVE_EASE, motionOn, SWAP_MS, TRAVEL_EASE } from '../lib/motion'

/**
 * A label whose text changes in place (TAL-1753): the old text fades out as the new fades in, in one slot that eases
 * between their widths, so what follows the label never snaps. Settled, it holds plain text and the caller's ellipsis
 * applies; only while the two lines swap is the slot a one-cell grid with both in it. `className` styles the slot.
 */
export function SwapText({ text, className }: { text: string; className?: string | undefined }) {
  const [view, setView] = useState({ text, out: null as string | null, swap: 0 })
  if (view.text !== text) setView({ text, out: motionOn() ? view.text : null, swap: view.swap + 1 })
  const slot = useRef<HTMLSpanElement>(null)
  const { out, swap } = view
  useLayoutEffect(() => {
    const el = slot.current
    const incoming = el?.querySelector<HTMLElement>(':scope > [data-swap-in]')
    const outgoing = el?.querySelector<HTMLElement>(':scope > [data-swap-out]')
    if (!el || !incoming || !outgoing) return
    const from = outgoing.getBoundingClientRect().width
    const to = incoming.getBoundingClientRect().width
    if (Math.abs(from - to) > 0.5) el.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: SWAP_MS, easing: TRAVEL_EASE })
    const step = SWAP_MS * 2 / 3
    outgoing.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-3px)' }], { duration: step, easing: 'ease-in', fill: 'forwards' })
    // The new line lands last; the slot returns to plain text once it has.
    const enter = incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: step, delay: SWAP_MS - step, easing: ARRIVE_EASE, fill: 'backwards' })
    void enter.finished.then(() => { setView((v) => v.swap === swap ? { ...v, out: null } : v) }, () => undefined)
  }, [swap])
  const line = 'col-start-1 row-start-1 justify-self-start whitespace-nowrap'
  return (
    <span ref={slot} className={cn(className, out !== null && 'inline-grid overflow-hidden')} data-swapping={out !== null || undefined}>
      {out !== null && <span key={`out:${swap}`} className={line} data-swap-out aria-hidden="true">{out}</span>}
      {out !== null ? <span key={`in:${swap}`} className={line} data-swap-in>{text}</span> : text}
    </span>
  )
}
