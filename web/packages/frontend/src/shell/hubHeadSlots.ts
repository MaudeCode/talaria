import { createContext } from 'react'

/** TAL-2101: a Settings section's heading, where a hub page shown as that section puts its help and actions. */
export interface HubHeadSlots { help: HTMLElement | null; actions: HTMLElement | null }
// Apart from `AppShell` so a Settings page can reach its heading without loading the shell (TAL-2132).
export const HubHeadSlotsContext = createContext<HubHeadSlots | null>(null)
