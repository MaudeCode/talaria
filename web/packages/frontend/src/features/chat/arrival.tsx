import { createContext, useContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { revealHeight } from '../../lib/motion'

/** The keys a turn last rendered, and the rows that attached in the commit since. */
interface Arrivals { known: Set<string>; mounted: Map<string, HTMLElement> }
const ArrivalContext = createContext<RefObject<Arrivals | null> | null>(null)

/**
 * A running turn's live tail (TAL-1753): a row that arrives after the turn first rendered, below every row it already
 * had, opens its height. Rows the turn mounted with, rows that remount (a run folding into a group), earlier steps
 * loaded above, and turns that are not running stay put, so history paging, virtual scrolling and entry never move.
 */
export function ArrivalScope({ keys, running, children }: { keys: string[]; running: boolean; children: ReactNode }) {
  const arrivals = useRef<Arrivals>(null)
  // Runs after the rows of this commit attached their elements.
  useLayoutEffect(() => {
    const last = arrivals.current
    arrivals.current = { known: new Set(keys), mounted: new Map() }
    if (!last || !running || last.mounted.size === 0) return
    const index = new Map(keys.map((key, i) => [key, i]))
    let tail = -1
    for (const key of last.known) tail = Math.max(tail, index.get(key) ?? -1)
    for (const [key, el] of last.mounted) if (!last.known.has(key) && (index.get(key) ?? -1) > tail) revealHeight(el, { open: true, arrive: true })
  })
  return <ArrivalContext value={arrivals}>{children}</ArrivalContext>
}

/** The ref for an activity row's element; outside a turn's scope, or without a key, it does nothing. */
export function useArrival(key: string | undefined): (el: HTMLElement | null) => void {
  const arrivals = useContext(ArrivalContext)
  return (el) => { if (el && key !== undefined) arrivals?.current?.mounted.set(key, el) }
}
