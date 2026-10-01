/** The reader asked for reduced motion: animations that move layout run instantly. */
export const prefersReducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The easing every composer layout move shares (T3 Code's `cubic-bezier(0.4, 0, 0.2, 1)`). */
export const MOTION_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'
