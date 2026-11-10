import { cn } from './cn'

/** TAL-2131: a provider's or profile's first letter on a rounded square, 30px, 24px when `sm`; decorative beside the name it starts. */
export function Monogram({ name, sm }: { name: string; sm?: boolean }) {
  return (
    <span aria-hidden="true" data-monogram="" className={cn('inline-flex shrink-0 items-center justify-center rounded-md bg-hover font-semibold uppercase text-text', sm ? 'size-6 text-xs' : 'size-[30px] text-sm')}>
      {Array.from(name.trim())[0] ?? '?'}
    </span>
  )
}
