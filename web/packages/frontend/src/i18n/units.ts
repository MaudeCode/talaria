type DurationUnit = 'day' | 'hour' | 'minute' | 'second'

/** A compact duration such as `1d 6h` or `42s`: each value in the locale's narrow unit, space-joined. */
export function formatDurationUnits(locale: string, ...parts: [number, DurationUnit][]): string {
  return parts.map(([n, unit]) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(n)).join(' ')
}
