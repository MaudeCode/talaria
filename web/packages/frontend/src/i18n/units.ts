type DurationUnit = 'day' | 'hour' | 'minute' | 'second'

/** A compact duration such as `1d 6h` or `42s`: each value in the locale's narrow unit, space-joined. */
export function formatDurationUnits(locale: string, ...parts: [number, DurationUnit][]): string {
  return parts.map(([n, unit]) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(n)).join(' ')
}

/** TAL-2321: seconds rounded to whole narrow units: `<1s`, `42s`, `3m 5s` (`3m` without `showSeconds`, and when the seconds
 *  are 0) or `1h 4m`; formatting only, the seconds are the caller's. */
export function formatElapsed(locale: string, totalSeconds: number, showSeconds = true): string {
  if (!(totalSeconds >= 1)) return `<${formatDurationUnits(locale, [1, 'second'])}`
  const seconds = Math.round(totalSeconds)
  const minutes = Math.floor(seconds / 60)
  if (seconds < 60) return formatDurationUnits(locale, [seconds, 'second'])
  if (minutes < 60) return formatDurationUnits(locale, [minutes, 'minute'], ...(showSeconds && seconds % 60 ? [[seconds % 60, 'second'] as [number, 'second']] : []))
  return formatDurationUnits(locale, [Math.floor(minutes / 60), 'hour'], [minutes % 60, 'minute'])
}

/**
 * A reset time (ISO string or epoch ms) in the viewer's zone: the time alone today, with its weekday within the week,
 * else with its date (a monthly window's reset is not this week's Thursday).
 */
export function resetTime(locale: string, value: string | number): string {
  const at = new Date(value)
  const now = new Date()
  const today = at.toDateString() === now.toDateString()
  const withinWeek = Math.abs(at.getTime() - now.getTime()) < 6 * 86_400_000
  return at.toLocaleString(locale, today ? { hour: 'numeric', minute: '2-digit' } : withinWeek ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Minutes as `1d 6h` / `18h` / `45m`; formatting only, the minutes are the server's. */
export function formatMinutes(locale: string, minutes: number): string {
  const total = Math.round(Math.abs(minutes))
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  if (days > 0) return formatDurationUnits(locale, [days, 'day'], [hours, 'hour'])
  return hours > 0 ? formatDurationUnits(locale, [hours, 'hour']) : formatDurationUnits(locale, [total, 'minute'])
}

/** A 0–100 server percent as the locale's percent string with at most `digits` fraction digits. */
export function formatPercent(locale: string, value: number, digits = 1): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(value / 100)
}

/** A server burn rate as `0.62×`; formatting only. */
export function formatBurnRate(locale: string, rate: number): string {
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rate)}×`
}

/** A count the way a stat or axis reads it ("1.2M", "48.2K"). */
export function formatCompact(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
