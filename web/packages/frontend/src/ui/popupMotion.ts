import { motionOn } from '../lib/motion'

/**
 * The one place floating surfaces get their motion (TAL-1784, from the owner-approved Stageshow demo). Opening takes
 * longer than closing and never delays interaction: a popup takes focus and clicks from its first frame, and a closing
 * one lets clicks through. Under reduced motion nothing scales or moves, and the base stylesheet makes the fade instant.
 */

/** Menus, context menus, Selects and popovers grow out of the side touching their trigger. */
export const POPUP_MOTION = 'origin-(--transform-origin) transition-[opacity,scale] duration-[160ms] ease-[cubic-bezier(0.25,0.8,0.25,1)] data-starting-style:scale-[.96] data-starting-style:opacity-0 data-ending-style:pointer-events-none data-ending-style:scale-[.98] data-ending-style:opacity-0 data-ending-style:duration-[110ms] data-ending-style:ease-in motion-reduce:scale-100!'

/** Tooltips slide 4px in from their side. Moving between tooltips of one group shows the next at once (`data-instant`). */
export const TOOLTIP_MOTION = 'transition-[opacity,translate] duration-[120ms] ease-out data-starting-style:opacity-0 data-[side=top]:data-starting-style:translate-y-1 data-[side=bottom]:data-starting-style:-translate-y-1 data-[side=left]:data-starting-style:translate-x-1 data-[side=right]:data-starting-style:-translate-x-1 data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-[80ms] data-ending-style:ease-in data-instant:duration-0 motion-reduce:translate-none!'

/**
 * Dialogs rise 8px and grow, then sink back. `transform` composes with the `translate` that centres them, so any
 * placement works. `starting:` covers a dialog mounted already open, which has no `data-starting-style` phase.
 */
export const DIALOG_MOTION = 'transition-[opacity,transform] duration-[260ms] ease-[cubic-bezier(0.25,0.8,0.25,1)] data-starting-style:opacity-0 data-starting-style:[transform:translateY(8px)_scale(.97)] starting:opacity-0 starting:[transform:translateY(8px)_scale(.97)] data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:[transform:translateY(8px)_scale(.97)] data-ending-style:duration-[150ms] data-ending-style:ease-in motion-reduce:transform-none!'

export const BACKDROP_MOTION = 'transition-opacity duration-[200ms] ease-out data-starting-style:opacity-0 starting:opacity-0 data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-[160ms]'

/**
 * A ref for a dialog part: most parents mount a dialog only while it shows, so closing unmounts it mid-frame with no exit
 * phase. The node React just removed goes back on the page, inert, for its exit transition. A node still connected is
 * StrictMode's simulated unmount, and one no longer open has already played its exit.
 */
export function playExitOnUnmount(el: HTMLElement | null) {
  return () => {
    queueMicrotask(() => {
      if (!el || el.isConnected || !el.hasAttribute('data-open') || !motionOn() || typeof el.getAnimations !== 'function') return
      el.inert = true
      // First its settled style, with no `starting:` entrance, so the exit has something to run from.
      el.style.transition = 'none'
      document.body.append(el)
      void getComputedStyle(el).opacity
      el.style.transition = ''
      el.setAttribute('data-ending-style', '')
      void Promise.allSettled(el.getAnimations().map((animation) => animation.finished)).then(() => { el.remove() })
    })
  }
}
