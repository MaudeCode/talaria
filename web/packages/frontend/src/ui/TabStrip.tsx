import { useRef, type KeyboardEvent } from 'react'
import { cn } from './cn'
import { rovingIndex } from './rovingIndex'

/** TAL-2131 (§2): the strip under a page's tabs, a hairline that scrolls sideways when its tabs do not fit. */
export const TAB_STRIP = 'flex min-w-0 max-w-full gap-4 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
/** One tab: underlined text, the selected one `text-strong` over a 2px accent line. Pages with their own tablist share it. */
export const tabClass = (selected: boolean) => cn('-mb-px shrink-0 whitespace-nowrap border-b-2 px-0.5 pb-2 pt-1 text-sm transition-colors', selected ? 'border-accent font-medium text-strong' : 'border-transparent text-muted hover:text-text')

/** The page tab strip (`docs/design-system.md` §2): `role="tablist"` of tab buttons; the selected one is underlined. */
export function TabStrip<T extends string>({ label, tabs, value, onChange, panelPrefix }: { label: string; tabs: readonly { id: T; label: () => string }[]; value: T; onChange: (id: T) => void; panelPrefix?: string }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = tabs.findIndex((tab) => tab.id === value)
  const stop = Math.max(0, selected)
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const next = rovingIndex(event.key, current, tabs.length, { rtl: event.currentTarget.matches(':dir(rtl)') })
    if (next === null) return
    const tab = tabs[next]
    if (!tab) return
    event.preventDefault()
    if (tab.id !== value) onChange(tab.id)
    buttons.current[next]?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className={TAB_STRIP}>
      {tabs.map((tab, i) => (
        <button key={tab.id} ref={(button) => { buttons.current[i] = button }} type="button" role="tab" aria-selected={i === selected} tabIndex={i === stop ? 0 : -1}
          aria-controls={panelPrefix ? `${panelPrefix}-${tab.id}` : undefined} onClick={() => onChange(tab.id)} onKeyDown={(event) => onKeyDown(event, i)}
          className={cn(tabClass(i === selected), 'focus-visible:-outline-offset-2!')}>
          {tab.label()}
        </button>
      ))}
    </div>
  )
}
