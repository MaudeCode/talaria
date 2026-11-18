import { useEffect, useState } from 'react'
import { formatElapsed } from '../../i18n/units'
import { useLocale } from '../../i18n/useLocale'

/** Time since the run started in T3 Code's units (TAL-922): `0s`, `42s`, then `5m`, then `1h 30m`, counting up by whole
 *  seconds. Redrawn each second and hidden from the live region so it is not announced every tick. */
export function RunElapsed({ since, showSeconds = false }: { since: number; showSeconds?: boolean }) {
  const locale = useLocale()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const text = formatElapsed(locale, Math.floor((now - since) / 1000), showSeconds, true)
  return <span className="live-run-elapsed" aria-hidden="true">{text}</span>
}
