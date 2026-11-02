import { vi } from 'vitest'

/** One `Element.animate` call: its target, keyframes and options, and controls for how it ends. */
export interface AnimateCall { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; finish: () => void; cancel: () => void; /** What `animate` returned, so a caller's `currentTime` seek can be read. */ animation: { finished: Promise<void>; cancel: () => void; currentTime?: number } }

/**
 * jsdom has no Web Animations. This records every `animate` call with a controllable `finished`, and optionally makes
 * the reader ask for reduced motion. Restore with `vi.unstubAllGlobals()` and `restore()`.
 */
export function stubAnimate({ reduced = false }: { reduced?: boolean } = {}) {
  const calls: AnimateCall[] = []
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  function animate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    let resolve: () => void = () => undefined
    let reject: (reason: unknown) => void = () => undefined
    const finished = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    const cancel = vi.fn(() => reject(new DOMException('cancelled', 'AbortError')))
    const call: AnimateCall = { el: this, keyframes, options, finish: () => resolve(), cancel, animation: { finished, cancel } }
    calls.push(call)
    return call.animation
  }
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: animate })
  return {
    calls,
    /** Calls that move height, the shared reveal (lib/motion.ts). */
    reveals: () => calls.filter((call) => 'height' in (call.keyframes[0] ?? {})),
    restore: () => { delete (Element.prototype as { animate?: unknown }).animate },
  }
}
