import type { ProviderIcon as Icon } from '@maudecode/talaria-web-contracts'
import { Brandmark } from '../shell/Brandmark'
import { appUrl } from './appRoot'
import { cn } from '../ui/cn'

/**
 * A catalog group's provider icon as the server resolved it (TAL-1858): its SVG under `static/brand/providers/`, in its
 * own colours or the text colour, or the server's initials in a tinted circle. Decorative; the control carries the name.
 */
export function ProviderIcon({ icon, className }: { icon: Icon | undefined; className?: string | undefined }) {
  const box = cn('inline-flex size-4 shrink-0 items-center justify-center', className)
  if (!icon?.asset) return <span data-provider-icon="initials" aria-hidden="true" className={cn(box, 'rounded-full bg-hover text-[8px] font-bold leading-none')}>{icon?.initials}</span>
  const src = `static/brand/providers/${icon.asset}.svg`
  if (icon.color) return <img data-provider-icon={icon.asset} src={appUrl(src).href} alt="" aria-hidden="true" className={cn(box, 'object-contain')} />
  return <Brandmark data-provider-icon={icon.asset} src={src} className={box} />
}
