type DurationUnit = 'day' | 'hour' | 'minute' | 'second'

/** A compact duration such as `1d 6h` or `42s`: each value in the locale's narrow unit, space-joined. */
export function formatDurationUnits(locale: string, ...parts: [number, DurationUnit][]): string {
  return parts.map(([n, unit]) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(n)).join(' ')
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

/** A count the way a stat or axis reads it ("1.2M", "48.2K"). */
export function formatCompact(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
