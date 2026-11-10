import type { ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'

/** A hidden part: a dashed outline in its own text colour, faded and struck through. The one definition both drawings use. */
const HIDDEN = 'border-dashed border-current! line-through opacity-50'

/**
 * TAL-2138, TAL-2145: one part of a Settings drawing of a component (the composer, the sidebar) as a toggle button, pressed
 * while the part is shown, named "Show {name}". `children` draws the part's face and receives the hidden style to put on it
 * (a face draws a border, transparent while shown, for the dashed outline to colour).
 */
export function PreviewToggle({ id, name, shown, onToggle, className, children }: { id: string; name: string; shown: boolean; onToggle: () => void; className?: string; children: (hidden: string | false) => ReactNode }) {
  return (
    <button type="button" id={id} aria-pressed={shown} aria-label={m.settings_preview_show({ item: name })} title={name} onClick={onToggle}
      className={cn('rounded-(--control-radius) outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)', className)}>
      {children(!shown && HIDDEN)}
    </button>
  )
}
