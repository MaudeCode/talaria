import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { ChevronLeft } from 'lucide-react'
import { m } from '../paraglide/messages.js'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

type Variant = 'default' | 'primary' | 'ghost' | 'ghost-danger' | 'danger' | 'link'

const VARIANT: Record<Variant, string> = {
  default: 'border border-border bg-surface text-text hover:bg-hover',
  primary: 'border border-transparent bg-accent text-accent-fg hover:bg-accent-hover',
  ghost: 'border border-transparent bg-transparent text-muted hover:bg-hover hover:text-text',
  'ghost-danger': 'border border-transparent bg-transparent text-error hover:bg-hover',
  danger: 'border border-transparent bg-error text-white',
  link: 'border-0 bg-transparent p-0 text-accent-text underline',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  ref?: Ref<HTMLButtonElement>
}

/** A button's classes, for a link that looks like one (an external authorization link). */
export const buttonClass = (variant: Variant = 'default', className?: string): string =>
  cn('inline-flex items-center justify-center gap-1.5 rounded-md font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-50', VARIANT[variant], variant !== 'link' && 'px-3 py-1.5 text-sm', className)

export function Button({ variant = 'default', className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} {...props} className={buttonClass(variant, className)} />
}

/** The way back from a detail to its list; `iconOnly` is the §12 symbol button Settings pages use. */
export function BackButton({ label = m.back(), iconOnly, ...props }: Omit<ButtonProps, 'variant' | 'children'> & { label?: string; iconOnly?: boolean }) {
  if (iconOnly) return <IconButton variant="ghost" label={label} {...props}><ChevronLeft aria-hidden="true" /></IconButton>
  return <Button variant="ghost" {...props}><ChevronLeft size={14} aria-hidden="true" /> {label}</Button>
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  children: ReactNode
  active?: boolean
  /**
   * TAL-2131 (§12): `default` is a 32px square with a hairline border, `primary` the accent fill (one per page, in its
   * header), `ghost` borderless and muted (header, group-header and row-menu actions), `danger` borderless in the error
   * colour. A variant also shows `label` in the shared `Tooltip`. Omitted, the button keeps the 34px toolbar look.
   */
  variant?: IconVariant
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
}

export type IconVariant = 'default' | 'primary' | 'ghost' | 'danger'

const ICON_VARIANT: Record<IconVariant, string> = {
  default: 'border border-border bg-surface text-text hover:bg-hover',
  primary: 'border border-transparent bg-accent text-accent-fg hover:bg-accent-hover',
  ghost: 'border border-transparent bg-transparent text-muted hover:bg-hover hover:text-text',
  danger: 'border border-transparent bg-transparent text-error hover:bg-hover',
}

/** An open disclosure's look (Catalog shown): it replaces the variant's colours rather than competing with them. */
const ICON_ACTIVE = 'border border-transparent bg-accent-bg text-accent-text'

/** A §12 symbol button's classes, for a link that looks like one (Open); wrap it in the shared `Tooltip`. */
export const iconButtonClass = (variant: IconVariant, className?: string, active = false): string => cn('inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11 [&_svg]:size-4', active ? ICON_ACTIVE : ICON_VARIANT[variant], className)

/** Square icon button with a mandatory accessible name; under a coarse pointer a variant grows to a 44px touch target. */
export function IconButton({ label, children, className, active, variant, tooltipSide = 'top', type = 'button', ...props }: IconButtonProps) {
  if (!variant) {
    return (
      <button type={type} aria-label={label} title={props.title ?? label} {...props} className={cn('inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border-0 transition-colors hover:bg-hover hover:text-text', active ? 'bg-accent-bg text-accent-text' : 'bg-transparent text-muted', className)}>
        {children}
      </button>
    )
  }
  return (
    <Tooltip label={label} side={tooltipSide}>
      <button type={type} aria-label={label} data-icon-button={variant} {...props} className={iconButtonClass(variant, className, active)}>


        {children}
      </button>
    </Tooltip>
  )
}
