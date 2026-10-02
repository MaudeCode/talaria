import { useState, type ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { Button } from '../../ui/Button'

/**
 * TAL-456: a body the server collapsed renders its excerpt until the reader asks for the rest. The server decides what is
 * collapsed (`_display_excerpt`, `final_answer_excerpt`); only the expanded state is local.
 */
export function CollapsedBody({ excerpt, children }: { excerpt: string | undefined; children: (text: string | null) => ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  if (!excerpt) return <>{children(null)}</>
  return (
    <>
      {children(expanded ? null : excerpt)}
      <Button variant="ghost" className="msg-collapse-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? m.show_less_message() : m.show_full_message()}
      </Button>
    </>
  )
}
