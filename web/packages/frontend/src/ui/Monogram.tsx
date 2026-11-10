import { useState } from 'react'
import { cn } from './cn'

/**
 * TAL-2131: a provider's or profile's first letter on a rounded square, 30px, 24px when `sm`; decorative beside the name it starts.
 * TAL-2176: `src` shows that image on the same square instead, and the letter again if it fails to load.
 */
export function Monogram({ name, sm, src }: { name: string; sm?: boolean; src?: string | undefined }) {
  const [failed, setFailed] = useState<string | null>(null)
  const size = sm ? 'size-6' : 'size-[30px]'
  if (src && failed !== src) return <img src={src} alt="" aria-hidden="true" data-monogram="" onError={() => setFailed(src)} className={cn('shrink-0 rounded-md bg-hover object-cover', size)} />
  return (
    <span aria-hidden="true" data-monogram="" className={cn('inline-flex shrink-0 items-center justify-center rounded-md bg-hover font-semibold uppercase text-text', size, sm ? 'text-xs' : 'text-sm')}>
      {Array.from(name.trim())[0] ?? '?'}
    </span>
  )
}
