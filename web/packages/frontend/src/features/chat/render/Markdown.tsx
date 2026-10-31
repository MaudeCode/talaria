import { Suspense, useSyncExternalStore, type ComponentType } from 'react'

export interface MarkdownProps {
  text: string
  streaming?: boolean
  className?: string
  /** Hostile content stays escaped by Streamdown's sanitizer; raw HTML is never rendered. */
  dir?: 'auto' | 'ltr' | 'rtl'
}

/**
 * TAL-1592: the renderer chunk loads once and every mounted Markdown reads it from this store. A store update is a
 * blocking render, unlike `lazy`'s Suspense retry: React restarts a retry from scratch on every newer update, so a long
 * transcript beside a ticking live turn could stay blank as long as the turn ran.
 */
let loaded: { Renderer: ComponentType<MarkdownProps> } | { error: unknown } | null = null
let loading = false
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!loaded && !loading) {
    loading = true
    void import('./MarkdownRenderer').then(({ default: Renderer }) => ({ Renderer }), (error: unknown) => ({ error })).then((result) => {
      loaded = result
      loading = false
      for (const notify of listeners) notify()
    })
  }
  return () => { listeners.delete(listener) }
}
const snapshot = () => loaded

/** One loading boundary for every Markdown consumer, including shared transcripts and previews. */
export function Markdown(props: MarkdownProps) {
  const renderer = useSyncExternalStore(subscribe, snapshot, snapshot)
  if (!renderer) return null
  // A failed chunk (deploy while the tab was open) reaches the route error boundary, as `lazy` did.
  if ('error' in renderer) throw renderer.error
  return <Suspense fallback={null}><renderer.Renderer {...props} /></Suspense>
}
