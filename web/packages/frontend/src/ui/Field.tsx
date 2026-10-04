import type { ReactNode, InputHTMLAttributes } from 'react'
import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { Popover } from '@base-ui/react/popover'
import { CircleHelp } from 'lucide-react'
import { m } from '../paraglide/messages.js'
import { cn } from './cn'

export function FieldRow({ label, hint, htmlFor, children, inline }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode; inline?: boolean }) {
  return (
    <div className={cn('flex gap-3 py-2', inline ? 'items-center justify-between' : 'flex-col')}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-sm text-text">{label}</label>
        {hint && <HelpTip label={typeof label === 'string' ? m.field_help_about({ label }) : m.field_help()}>{hint}</HelpTip>}
      </div>
      <div className={cn(inline ? 'shrink-0' : '')}>{children}</div>
    </div>
  )
}

/** A "?" beside a label: the explanation opens on click or tap instead of sitting under every setting. The 20px icon keeps a 44px touch target. */
export function HelpTip({ label, children, className = 'translate-y-[3px] align-top' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger aria-label={label} className={cn("relative ml-1.5 inline-flex size-5 before:absolute before:-inset-3 before:content-[''] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-2 focus-visible:outline-accent data-popup-open:text-text", className)}>
        <CircleHelp size={14} strokeWidth={1.75} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={6} className="z-[1500]">
          <Popover.Popup className="max-w-[min(18rem,calc(100vw-2rem))] rounded-md border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-text shadow-md outline-none">{children}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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
