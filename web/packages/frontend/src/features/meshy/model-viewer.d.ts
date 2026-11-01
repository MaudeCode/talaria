import type { DetailedHTMLProps, HTMLAttributes, Ref } from 'react'

/** `@google/model-viewer`'s custom element as React renders it: attributes pass through as written. */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { ref?: Ref<HTMLElement & { play: (options?: { repetitions?: number }) => void; pause: () => void; availableAnimations?: string[]; animationName?: string | null }>; [attribute: string]: unknown }
    }
  }
}
