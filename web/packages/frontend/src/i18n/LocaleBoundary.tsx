import { Fragment, type ReactNode } from 'react'
import { useLocale } from './useLocale'

/**
 * Remounts its subtree when the locale changes. Compiled components cache `m.*()` text with no dependency on the
 * locale, so a re-render alone would keep the previous language.
 */
export function LocaleBoundary({ children }: { children: ReactNode }) {
  return <Fragment key={useLocale()}>{children}</Fragment>
}
