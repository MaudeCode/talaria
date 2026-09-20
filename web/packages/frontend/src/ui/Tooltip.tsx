import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <BaseTooltip.Provider delay={400}>{children}</BaseTooltip.Provider>
}

/** Accessible tooltip: the trigger keeps its own accessible name; the popup adds a description. */
export function Tooltip({ label, side = 'right', children }: { label: string; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactElement }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={8} className="z-[1500]">
          <BaseTooltip.Popup className="rounded-md border border-accent-bg-strong bg-surface px-2.5 py-1.5 text-[11.5px] font-semibold tracking-wide text-text shadow-md">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
