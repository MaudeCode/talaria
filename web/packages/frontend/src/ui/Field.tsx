import type { ReactNode, InputHTMLAttributes } from 'react'
import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { cn } from './cn'

export function FieldRow({ label, hint, htmlFor, children, inline }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode; inline?: boolean }) {
  return (
    <div className={cn('flex gap-3 py-2', inline ? 'items-center justify-between' : 'flex-col')}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-sm text-text">{label}</label>
        {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
      </div>
      <div className={cn(inline ? 'shrink-0' : '')}>{children}</div>
    </div>
  )
}


export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn('h-9 w-full rounded-md border border-border bg-input px-3 text-sm text-text placeholder:text-muted focus:border-accent', className)} />
}

/** Boolean setting control (legacy `.plugin-toggle-switch` geometry: 32x18 track, 12px thumb). Renders a `role="switch"` button. */
export function Switch({ className, ...props }: Omit<BaseSwitch.Root.Props, 'className'> & { className?: string }) {
  return (
    <BaseSwitch.Root {...props} className={cn('relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border-0 bg-border2 p-0 transition-colors duration-200 data-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-50', className)}>
      <BaseSwitch.Thumb className="block size-3 translate-x-[3px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.45)] transition-transform duration-200 data-checked:translate-x-[17px]" />
    </BaseSwitch.Root>
  )
}
