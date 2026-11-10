import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** TAL-2101: a Settings section's heading, where a hub page shown as that section puts its help and actions. */
export interface HubHeadSlots { help: HTMLElement | null; actions: HTMLElement | null }
// Apart from `AppShell` so a Settings page can reach its heading without loading the shell (TAL-2132).
export const HubHeadSlotsContext = createContext<HubHeadSlots | null>(null)

/** TAL-2140: actions for the Settings section heading; outside a Settings section they render in place. */
export function HubHeadActions({ children }: { children: ReactNode }) {
  const slots = useContext(HubHeadSlotsContext)
  if (!slots) return children
  return slots.actions ? createPortal(children, slots.actions) : null
}
