import { createContext } from 'react'

export interface LinkCheck { opens_directly: boolean; host: string | null }

/** Shared transcripts outside the signed-in layout always warn before opening links. */
export const LinkCheckContext = createContext<((url: string) => Promise<LinkCheck>) | null>(null)
