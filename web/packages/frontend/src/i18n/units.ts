type DurationUnit = 'day' | 'hour' | 'minute' | 'second'

/** A compact duration such as `1d 6h` or `42s`: each value in the locale's narrow unit, space-joined. */
export function formatDurationUnits(locale: string, ...parts: [number, DurationUnit][]): string {
  return parts.map(([n, unit]) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(n)).join(' ')
}

/** A reset time (ISO string or epoch ms) in the viewer's zone: the time alone today, else with its weekday. */
export function resetTime(locale: string, value: string | number): string {
  const at = new Date(value)
  const today = at.toDateString() === new Date().toDateString()
  return at.toLocaleString(locale, today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}
