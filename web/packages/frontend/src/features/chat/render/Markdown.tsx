import { Suspense, useEffect, useState, useSyncExternalStore, type ComponentType } from 'react'

export interface MarkdownProps {
  text: string
  /** Keep the current turn's block renderer mounted when another activity takes the tail. */
  liveTurn?: boolean
  streaming?: boolean
  /** `fade_text_effect` setting (TAL-2148): streamed words fade in; reduced motion and code never animate. */
  fade?: boolean
  className?: string
  /** Hostile content stays escaped by Streamdown's sanitizer; raw HTML is never rendered. */
  dir?: 'auto' | 'ltr' | 'rtl'
}

/**
 * TAL-1592: the renderer chunk loads once and every mounted Markdown reads it from this store. A store update is a
 * blocking render, unlike `lazy`'s Suspense retry: React restarts a retry from scratch on every newer update, so a long
 * transcript beside a ticking live turn could stay blank as long as the turn ran.
 *
 * TAL-1637: instances mounted before the chunk loaded are released a batch per task, newest first, so one blocking
 * render of a long history cannot hold every other task (a live turn attaching, a stream frame) for seconds. Each
 * batch is still a blocking render that no tick can restart. Instances mounted after the load render at once.
 */
let loaded: { Renderer: ComponentType<MarkdownProps> } | { error: unknown } | null = null
/** The one chunk request, settled once `loaded` is set. */
let request: Promise<void> | null = null
let draining = false
// ponytail: fixed count; each batch also pays one layout of the transcript, so smaller batches finish the history
// later. Size batches by measured render time if slow devices still show long tasks.
const BATCH = 32
/** Mount order; the newest mounts are a transcript's latest rows, the ones on screen. */
const waiting = new Set<Gate>()
/** Subscribers of `useMarkdownRendererReady`, told once when the chunk settles. */
const settled = new Set<() => void>()

class Gate {
  ready = loaded !== null
  notify: (() => void) | null = null
  subscribe = (notify: () => void): (() => void) => {
    this.notify = notify
    if (!this.ready) {
      waiting.add(this)
      if (loaded) drain()
      else void preloadMarkdownRenderer()
    }
    return () => { this.notify = null; waiting.delete(this) }
  }
  snapshot = () => (this.ready ? loaded : null)
}

/**
 * TAL-1693: the single import of the renderer chunk. The client entry starts it before the bootstrap so it downloads
 * beside the bootstrap and session fetches; the first mounted Markdown reuses the same request.
 */
export function preloadMarkdownRenderer(): Promise<void> {
  request ??= import('./MarkdownRenderer').then(({ default: Renderer }) => ({ Renderer }), (error: unknown) => ({ error })).then((result) => {
    loaded = result
    drain()
    for (const notify of settled) notify()
  })
  return request
}

function drain(): void {
  if (draining || !loaded) return
  draining = true
  // A failed chunk throws in every instance at once; there is nothing to render.
  const gates = 'error' in loaded ? [...waiting] : [...waiting].slice(-BATCH)
  for (const gate of gates) {
    waiting.delete(gate)
    gate.ready = true
    gate.notify?.()
  }
  setTimeout(() => {
    draining = false
    if (waiting.size) drain()
  }, 0)
}

const subscribeSettled = (notify: () => void): (() => void) => {
  settled.add(notify)
  return () => { settled.delete(notify) }
}

/**
 * TAL-2410: whether the renderer chunk has settled (loaded or failed). A transcript holds its history until then, so its
 * rows mount once at their rendered height: no raw-text fallback matches a rendered code fence or list. A caller with
 * nothing to show (`wanted` false) neither loads the chunk nor waits for it, so login and onboarding never fetch it.
 */
export function useMarkdownRendererReady(wanted: boolean): boolean {
  useEffect(() => { if (wanted) void preloadMarkdownRenderer() }, [wanted])
  return useSyncExternalStore(subscribeSettled, () => loaded !== null, () => false)
}

/** One loading boundary for every Markdown consumer, including shared transcripts and previews. */
export function Markdown(props: MarkdownProps) {
  const [gate] = useState(() => new Gate())
  const renderer = useSyncExternalStore(gate.subscribe, gate.snapshot, gate.snapshot)
  // TAL-1693: the raw text holds roughly the rendered height, so rows do not grow under the reader when the chunk lands.
  if (!renderer) return <div className={props.className ?? 'hermes-prose'} dir={props.dir} style={{ whiteSpace: 'pre-wrap' }}>{props.text}</div>
  // A failed chunk (deploy while the tab was open) reaches the route error boundary, as `lazy` did.
  if ('error' in renderer) throw renderer.error
  return <Suspense fallback={null}><renderer.Renderer {...props} /></Suspense>
}
