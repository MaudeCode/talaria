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
 * `finished` resolves. `hold` keeps the end state until the caller cancels after its removal commit. Returns null,
 * leaving the end state to the caller, under reduced motion or inside a hidden box.
 */
export function revealHeight(el: HTMLElement, { open, from, arrive = false, hold = false }: { open: boolean; from?: 'below'; /** New content landing rather than a disclosure travelling. */ arrive?: boolean; hold?: boolean }): Animation | null {
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
  // A retained exit must stay collapsed while React schedules its removal and takes the next layout snapshot.
  const forget = () => { if (reveals.get(el) === animation) reveals.delete(el) }
  void animation.finished.then(() => { if (!hold) { forget(); animation.cancel() } }, forget)
  return animation
}

/** Follow a streaming body's natural size without clipping. ResizeObserver lets the pinned transcript follow each painted height. */
export function followHeight(wrapper: HTMLElement, content: HTMLElement): () => void {
  if (!motionOn() || typeof ResizeObserver === 'undefined') return () => undefined
  const original = wrapper.style.height
  let target = content.getBoundingClientRect().height
  let animation: Animation | null = null
  wrapper.style.height = `${target}px`
  const observer = new ResizeObserver(() => {
    const next = content.getBoundingClientRect().height
    if (next === target) return
    const from = wrapper.getBoundingClientRect().height
    animation?.cancel()
    target = next
    wrapper.style.height = `${next}px`
    if (!motionOn() || Math.abs(next - from) < 0.5) return
    const move = wrapper.animate([{ height: `${from}px` }, { height: `${next}px` }], { duration: 200, easing: ARRIVE_EASE })
    animation = move
    void move.finished.then(() => { if (animation === move) animation = null }, () => undefined)
  })
  observer.observe(content)
  return () => {
    observer.disconnect()
    animation?.cancel()
    wrapper.style.height = original
    if (!wrapper.style.cssText) wrapper.removeAttribute('style')
  }
}

export type ListSnapshot = Map<string, { el: HTMLElement; rect: DOMRect; group: string | null }>

/** Only rendered boxes participate. Measuring skipped content would defeat content-visibility. */
export function measureList(container: HTMLElement, keyAttr = 'data-motion-key'): ListSnapshot {
  const snapshot: ListSnapshot = new Map()
  for (const el of container.querySelectorAll<HTMLElement>(`[${keyAttr}]`)) {
    if (el.closest('[hidden],[style*="display: none"]') || (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }))) continue
    const key = el.getAttribute(keyAttr)
    if (!key) continue
    const rect = el.getBoundingClientRect()
    if (rect.width && rect.height) snapshot.set(key, { el, rect, group: el.closest('[data-motion-group]')?.getAttribute('data-motion-group') ?? null })
  }
  return snapshot
}

/** FLIP the wrapper, leaving the row's own swipe transform alone. Call after reveals establish their starting size. */
export function flipList(container: HTMLElement, before: ListSnapshot, keyAttr = 'data-motion-key'): Animation[] {
  if (!motionOn()) return []
  const animations: Animation[] = []
  for (const [key, { el, rect, group }] of measureList(container, keyAttr)) {
    const old = before.get(key)
    if (!old) continue
    const x = old.rect.left - rect.left, y = old.rect.top - rect.top
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue
    const lifted = old.group !== group
    animations.push(el.animate([
      { transform: `translate(${x}px, ${y}px)`, ...(lifted && { background: 'var(--surface)', boxShadow: 'var(--shadow-md)', position: 'relative', zIndex: 1 }) },
      { transform: 'none', ...(lifted && { background: 'transparent', boxShadow: 'none', position: 'relative', zIndex: 1 }) },
    ], { duration: 400, easing: TRAVEL_EASE }))
  }
  return animations
}

/** Position the shared selection in scroll-content coordinates; an interrupted move starts at its painted rect. */
export function moveSelection(el: HTMLElement, container: HTMLElement, target: HTMLElement | null, from: DOMRect | null): Animation | null {
  if (!target || target.closest('[hidden],[style*="display: none"]')) { el.hidden = true; return null }
  const rect = target.getBoundingClientRect(), box = container.getBoundingClientRect()
  if (!rect.width || !rect.height) { el.hidden = true; return null }
  el.hidden = false
  Object.assign(el.style, { left: `${rect.left - box.left + container.scrollLeft}px`, top: `${rect.top - box.top + container.scrollTop}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  if (!from || !motionOn() || container.closest('[hidden]')) return null
  const x = from.left - rect.left, y = from.top - rect.top
  return Math.abs(x) < 0.5 && Math.abs(y) < 0.5 ? null : el.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }], { duration: 360, easing: TRAVEL_EASE })
}

/** The label renderer owns presence; all of its animation writes stay here. Fixed title slots only cross-fade. */
export function swapLabel(el: HTMLElement, incoming: HTMLElement, outgoing: HTMLElement, fixed: boolean): { animations: Animation[]; enter: Animation } {
  const animations: Animation[] = []
  const from = outgoing.getBoundingClientRect().width, to = incoming.getBoundingClientRect().width
  if (!fixed && Math.abs(from - to) > 0.5) animations.push(el.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: SWAP_MS, easing: TRAVEL_EASE }))
  const step = fixed ? 200 : SWAP_MS * 2 / 3
  animations.push(outgoing.animate([{ opacity: 1 }, { opacity: 0, ...(!fixed && { transform: 'translateY(-3px)' }) }], { duration: step, easing: 'ease-in', fill: 'forwards' }))
  const enter = incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: step, delay: fixed ? 0 : SWAP_MS - step, easing: ARRIVE_EASE, fill: 'backwards' })
  animations.push(enter)
  for (const animation of animations) void animation.finished.catch(() => undefined)
  return { animations, enter }
}

/** Only the tail's painted rows enter, after the transcript has pinned itself. No height changes or interaction lock. */
export function enterTranscript(pane: HTMLElement): Animation[] {
  if (!motionOn()) return []
  const bounds = pane.getBoundingClientRect()
  const rows = [...pane.querySelectorAll<HTMLElement>('.msg-row[data-message-key], .msg-row[data-live]')].slice(-4).filter((el) => {
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) return false
    const rect = el.getBoundingClientRect()
    return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
  })
  return rows.flatMap((el, i) => {
    const delay = (i + 1) * 40
    const animations = [
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay, fill: 'backwards', easing: 'ease' }),
      el.animate([{ transform: 'translateY(10px)' }, { transform: 'none' }], { duration: 420, delay, fill: 'backwards', easing: ARRIVE_EASE }),
    ]
    for (const animation of animations) void animation.finished.catch(() => undefined)
    return animations
  })
}
