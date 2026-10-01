import { prefersReducedMotion } from '../../lib/motion'

/** Composer and transcript motion around a send (TAL-429): the hero-to-dock FLIP and transcript scroll requests. */
export const DOCK_MS = 340
const DOCK_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'
let dock: { fromTop: number; start: number } | null = null

/** Hero → docked: remember where the composer was; `playDock` moves it from there, in this view or the next one. */
export function beginDock(fromTop: number): void {
  dock = prefersReducedMotion() ? null : { fromTop, start: performance.now() }
}

/** FLIP the docked composer from the recorded hero position, resuming at the elapsed time when a remount interrupted it. */
export function playDock(el: HTMLElement): void {
  if (!dock || typeof el.animate !== 'function') return
  const elapsed = performance.now() - dock.start
  if (elapsed >= DOCK_MS) { dock = null; return }
  const dy = dock.fromTop - el.getBoundingClientRect().top
  if (Math.abs(dy) < 1) return
  const animation = el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: DOCK_MS, easing: DOCK_EASE })
  animation.currentTime = elapsed
}

/**
 * Transcript scroll requests. `end`: every submit (send, steer, queue) brings the transcript to its end, wherever the
 * reader had scrolled. `follow`: the composer's height changed, so a pinned transcript follows in the same frame.
 * `reader`: the reader scrolled an overflowing transcript by hand, which rests the composer (T3 Code's resting row).
 */
type ScrollRequest = 'end' | 'follow' | 'reader'
const scrollRequests = new EventTarget()
export const requestScroll = (kind: ScrollRequest) => { scrollRequests.dispatchEvent(new Event(kind)) }
export function onScrollRequest(kind: ScrollRequest, fn: () => void): () => void {
  scrollRequests.addEventListener(kind, fn)
  return () => scrollRequests.removeEventListener(kind, fn)
}
