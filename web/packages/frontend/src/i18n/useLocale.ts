import { useSyncExternalStore } from 'react'
import { currentLocale, subscribeLocale } from './runtime'

/** Re-renders the subscriber when the runtime locale changes. */
export function useLocale(): string {
  return useSyncExternalStore(subscribeLocale, currentLocale, currentLocale)
}
