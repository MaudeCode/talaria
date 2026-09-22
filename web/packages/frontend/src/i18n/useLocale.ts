import { useSyncExternalStore } from 'react'
import { currentLocale, localeVersion, subscribeLocale } from './runtime'

/** Re-renders the subscriber when the runtime locale changes. */
export function useLocale(): string {
  useSyncExternalStore(subscribeLocale, localeVersion, localeVersion)
  return currentLocale()
}
