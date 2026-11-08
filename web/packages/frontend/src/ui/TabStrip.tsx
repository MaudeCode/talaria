import { cn } from './cn'

/** The page tab strip (`docs/design-system.md` §2): `role="tablist"` of tab buttons; the active one takes the accent. */
export function TabStrip<T extends string>({ label, tabs, value, onChange, panelPrefix }: { label: string; tabs: readonly { id: T; label: () => string }[]; value: T; onChange: (id: T) => void; panelPrefix?: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} {...(panelPrefix ? { 'aria-controls': `${panelPrefix}-${t.id}` } : {})} onClick={() => onChange(t.id)} className={cn('rounded-md px-3 py-1.5 text-sm', value === t.id ? 'bg-accent-bg text-accent-text' : 'text-muted hover:bg-hover hover:text-text')}>
          {t.label()}
        </button>
      ))}
    </div>
  )
}
