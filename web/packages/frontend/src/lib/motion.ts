/** The reader asked for reduced motion: animations that move layout run instantly. */
export const prefersReducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The easing every composer layout move shares (T3 Code's `cubic-bezier(0.4, 0, 0.2, 1)`). */
export const MOTION_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'

/** Chat motion (TAL-1753, from the owner-approved Stageshow demo): space opening or closing travels; new content arrives. */
export const TRAVEL_EASE = 'cubic-bezier(0.45, 0, 0.1, 1)'
export const ARRIVE_EASE = 'cubic-bezier(0.25, 0.8, 0.25, 1)'
export const REVEAL_MS = 300
export const SWAP_MS = 180

/** Web Animations run here: the browser has them and the reader has not asked for reduced motion. */
export const motionOn = (): boolean => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function' && !prefersReducedMotion()

const BOX = ['height', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom'] as const
const reveals = new WeakMap<HTMLElement, Animation>()

/**
 * The one place chat height motion is written. Opens (`open`) or shuts an element's height, vertical padding and
 * margins together with its opacity, so whatever follows it moves with it. Opening, the content fades in over the
 * first half of the travel; `from: 'below'` also lifts it a few pixels, for a message landing at the end of a feed.
 * Shutting, it dims fast and dissolves as the edge passes. A reveal already running on the element is reversed from
 * where it is. Styles live only in the animation, so nothing is left inline; the caller hides a shut element once
 * `finished` resolves. Returns null, leaving the end state to the caller, under reduced motion or inside a hidden box.
 */
export function revealHeight(el: HTMLElement, { open, from, arrive = false }: { open: boolean; from?: 'below'; /** New content landing rather than a disclosure travelling. */ arrive?: boolean }): Animation | null {
  if (!motionOn() || typeof el.animate !== 'function' || el.closest('[hidden]')) return null
  const box = (style: CSSStyleDeclaration, height: number) => Object.fromEntries(BOX.map((p) => [p, p === 'height' ? `${height}px` : style[p]]))
  const zero = Object.fromEntries(BOX.map((p) => [p, '0px']))
  const running = reveals.get(el)
  // Mid-reveal, start from what is on screen now; otherwise from nothing (opening) or the settled box (shutting).
  const now = running ? { ...box(getComputedStyle(el), el.getBoundingClientRect().height), opacity: Number(getComputedStyle(el).opacity) } : null
  running?.cancel()
  const settled = { ...box(getComputedStyle(el), el.getBoundingClientRect().height), opacity: 1 }
  const keyframes: Keyframe[] = open
    ? [{ ...(now ?? { ...zero, opacity: 0 }), overflow: 'hidden', ...(from === 'below' && { transform: 'translateY(8px)' }) }, { opacity: 1, offset: 0.5 }, { ...settled, overflow: 'hidden', ...(from === 'below' && { transform: 'none' }) }]
    : [{ ...(now ?? settled), overflow: 'hidden' }, { opacity: Math.min(0.33, now?.opacity ?? 1), offset: 0.3 }, { ...zero, opacity: 0, overflow: 'hidden' }]
  const animation = el.animate(keyframes, { duration: REVEAL_MS, easing: arrive ? ARRIVE_EASE : TRAVEL_EASE, fill: 'forwards' })
  reveals.set(el, animation)
  // Held until the caller's own `finished` handlers run in the same task, then handed back to the stylesheet.
  void animation.finished.then(() => { if (reveals.get(el) === animation) reveals.delete(el); animation.cancel() }, () => undefined)
  return animation
}
