import { useRef, type KeyboardEvent } from 'react'
import { cn } from './cn'

export interface SegmentedOption { value: string; label: string }

/**
 * TAL-2131 (§12): two to four short options side by side, the selected one filled. A `radiogroup` with one Tab stop:
 * arrow keys, Home and End move the selection. Siblings rejected: `Select` hides the options, `TabStrip` is navigation.
 */
export function Segmented({ id, label, options, value, onChange, disabled }: { id?: string; label: string; options: readonly SegmentedOption[]; value: string; onChange: (value: string) => void; disabled?: boolean | undefined }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(0, options.findIndex((o) => o.value === value))
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : step ? (selected + step + options.length) % options.length : null
    const option = next === null ? undefined : options[next]
    if (!option || next === null) return
    e.preventDefault()
    if (option.value !== value) onChange(option.value)
    buttons.current[next]?.focus()
  }
  return (
    <div id={id} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={disabled ? undefined : onKeyDown} className="inline-flex shrink-0 rounded-md border border-border p-0.5">
      {options.map((o, i) => {
        const checked = i === selected
        return (
          <button key={o.value} ref={(el) => { buttons.current[i] = el }} type="button" role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1} disabled={disabled} onClick={() => { if (!checked) onChange(o.value) }}
            className={cn('min-h-7 whitespace-nowrap rounded px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11', checked ? 'bg-accent-bg text-accent-text' : 'text-muted hover:text-text')}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
