import { MOTION_EASE, prefersReducedMotion, REVEAL_MS, revealHeight } from '../../lib/motion'

/** Composer and transcript motion around a send (TAL-429): the hero-to-dock FLIP and transcript scroll requests. */
export const DOCK_MS = 340
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
  const animation = el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: DOCK_MS, easing: MOTION_EASE })
  animation.currentTime = elapsed
}

let landing: { text: string; start: number } | null = null
/**
 * The sent message lands from below (TAL-1753). A new chat's first send remounts its pending row in the session view;
 * the same text landing again within the reveal resumes at the elapsed time instead of starting over.
 */
export function landSent(el: HTMLElement, text: string): void {
  const now = performance.now()
  const elapsed = landing?.text === text ? now - landing.start : REVEAL_MS
  if (elapsed >= REVEAL_MS) landing = { text, start: now }
  const animation = revealHeight(el, { open: true, from: 'below', arrive: true })
  if (animation && elapsed < REVEAL_MS) animation.currentTime = elapsed
}

/**
 * Transcript scroll requests. `end`: every submit (send, steer, queue) brings the transcript to its end, wherever the
 * reader had scrolled. `follow`: the composer's height changed, so a pinned transcript follows in the same frame.
 */
type ScrollRequest = 'end' | 'follow'
const scrollRequests = new EventTarget()
export const requestScroll = (kind: ScrollRequest) => { scrollRequests.dispatchEvent(new Event(kind)) }
export function onScrollRequest(kind: ScrollRequest, fn: () => void): () => void {
  scrollRequests.addEventListener(kind, fn)
  return () => scrollRequests.removeEventListener(kind, fn)
}

/** The reader scrolled an overflowing transcript by hand: the composer may rest (T3 Code's resting row). */
export const REST_MS = 200
const restRequests = new EventTarget()
export const requestComposerRest = () => { restRequests.dispatchEvent(new Event('rest')) }
export function onComposerRestRequest(fn: () => void): () => void {
  restRequests.addEventListener('rest', fn)
  return () => restRequests.removeEventListener('rest', fn)
}
