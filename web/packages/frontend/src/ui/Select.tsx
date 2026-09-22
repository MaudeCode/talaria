import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { cn } from './cn'

interface Opt { value: string; label: ReactNode; disabled: boolean }
interface Group { label: ReactNode; options: Opt[] }

/** Read `<option>` / `<optgroup>` children so call sites keep the native-select markup. */
function collect(children: ReactNode): (Opt | Group)[] {
  const out: (Opt | Group)[] = []
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue
    const el = child as ReactElement<{ value?: string | number; label?: string; disabled?: boolean; children?: ReactNode }>
    if (el.type === 'option') out.push({ value: String(el.props.value ?? ''), label: el.props.children, disabled: !!el.props.disabled })
    else if (el.type === 'optgroup') out.push({ label: el.props.label, options: collect(el.props.children).filter((o): o is Opt => 'value' in o) })
    else out.push(...collect(el.props.children))
  }
  return out
}

export interface SelectProps {
  value: string | number | null | undefined
  onValueChange: (value: string) => void
  children: ReactNode
  id?: string
  disabled?: boolean
  className?: string
  placeholder?: ReactNode
  'aria-label'?: string
}

/**
 * Single-value picker on Base UI Select (keyboard navigation, typeahead, focus return)
 * styled on the theme tokens. Accepts `<option>`/`<optgroup>` children like a native select.
 */
export function Select({ value, onValueChange, children, id, disabled, className, placeholder, 'aria-label': ariaLabel }: SelectProps) {
  const entries = collect(children)
  const flat = entries.flatMap((e) => ('options' in e ? e.options : [e]))
  const current = value === null || value === undefined ? undefined : flat.find((o) => o.value === String(value))
  const item = (o: Opt) => (
    <BaseSelect.Item key={o.value} value={o.value} disabled={o.disabled} className="grid cursor-default select-none grid-cols-[14px_1fr] items-center gap-2 rounded-md py-1.5 pr-2.5 pl-2 outline-none data-highlighted:bg-hover data-disabled:opacity-50">
      <BaseSelect.ItemIndicator className="col-start-1 flex text-accent-text"><Check size={14} aria-hidden="true" /></BaseSelect.ItemIndicator>
      <BaseSelect.ItemText className="col-start-2 truncate">{o.label}</BaseSelect.ItemText>
    </BaseSelect.Item>
  )
  return (
    <BaseSelect.Root value={current?.value ?? null} onValueChange={(v) => onValueChange(v ?? '')} disabled={disabled ?? false}>
      <BaseSelect.Trigger id={id} aria-label={ariaLabel} className={cn('inline-flex h-8 min-w-0 max-w-full items-center justify-between gap-2 rounded-md border border-border bg-input pl-2.5 pr-2 text-sm text-text outline-none transition-[border-color,box-shadow] duration-(--dur) hover:border-border2 focus-visible:border-accent focus-visible:shadow-(--input-focus-shadow) data-popup-open:border-accent disabled:cursor-not-allowed disabled:opacity-60', className)}>
        <BaseSelect.Value className={cn('truncate', !current && 'text-muted')}>{current ? current.label : placeholder ?? '—'}</BaseSelect.Value>
        <BaseSelect.Icon className="flex shrink-0 text-muted"><ChevronDown size={14} aria-hidden="true" /></BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-[1200] outline-none">
          <BaseSelect.Popup className="max-h-[min(60vh,360px)] min-w-(--anchor-width) overflow-y-auto rounded-lg border border-border bg-surface p-1 text-sm text-text shadow-md outline-none">
            {entries.map((e, i) => ('options' in e
              ? <BaseSelect.Group key={i}><BaseSelect.GroupLabel className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{e.label}</BaseSelect.GroupLabel>{e.options.map(item)}</BaseSelect.Group>
              : item(e)))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
