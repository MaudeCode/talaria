import { lazy, Suspense } from 'react'

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'))

export interface MarkdownProps {
  text: string
  streaming?: boolean
  className?: string
  /** Hostile content stays escaped by Streamdown's sanitizer; raw HTML is never rendered. */
  dir?: 'auto' | 'ltr' | 'rtl'
}

/** One loading boundary for every Markdown consumer, including shared transcripts and previews. */
export function Markdown(props: MarkdownProps) {
  return <Suspense fallback={null}><MarkdownRenderer {...props} /></Suspense>
}
