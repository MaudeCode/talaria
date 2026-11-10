import { cn } from './cn'

/** TAL-2131 (§2): the strip under a page's tabs, a hairline that scrolls sideways when its tabs do not fit. */
export const TAB_STRIP = 'flex min-w-0 max-w-full gap-4 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
/** One tab: underlined text, the selected one `text-strong` over a 2px accent line. Pages with their own tablist share it. */
export const tabClass = (selected: boolean) => cn('-mb-px shrink-0 whitespace-nowrap border-b-2 px-0.5 pb-2 pt-1 text-sm transition-colors', selected ? 'border-accent font-medium text-strong' : 'border-transparent text-muted hover:text-text')

/** The page tab strip (`docs/design-system.md` §2): `role="tablist"` of tab buttons; the selected one is underlined. */
export function TabStrip<T extends string>({ label, tabs, value, onChange, panelPrefix }: { label: string; tabs: readonly { id: T; label: () => string }[]; value: T; onChange: (id: T) => void; panelPrefix?: string }) {
  return (
    <div role="tablist" aria-label={label} className={TAB_STRIP}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} {...(panelPrefix ? { 'aria-controls': `${panelPrefix}-${t.id}` } : {})} onClick={() => onChange(t.id)} className={tabClass(value === t.id)}>
          {t.label()}
        </button>
      ))}
    </div>
  )
}
