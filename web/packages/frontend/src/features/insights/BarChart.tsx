import { useId, useState, type ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'

export interface BarChartRow { label: string; value: number; /** Longer label for the hover title and the table; defaults to `label`. */ title?: string; /** TAL-1968: the value as the server formatted it; defaults to `format(value)`. */ display?: string }

/**
 * One series of bars on a baseline: a y-max label, each bar's value on hover, x labels under every bar when they fit
 * (else first and last), and the table twin behind a disclosure. One hue; the title says what is plotted.
 * TAL-1968: `variant: 'line'` draws the same series as a line through each bar's centre; `maxDisplay` and `peak` are the
 * scale label and peak point the server chose. A negative value plots below a zero line, and its bar hangs from it.
 */
export function BarChart({ title, rows, format = String, controls, id, variant = 'bar', maxDisplay, peak: serverPeak }: { title: string; rows: BarChartRow[]; format?: (value: number) => string; controls?: ReactNode; id: string; variant?: 'bar' | 'line'; maxDisplay?: string; peak?: { label: string; display: string } }) {
  const tableId = useId()
  const shown = (r: BarChartRow) => r.display ?? format(r.value)
  // The table twin is always in the tree for assistive technology; the toggle only reveals it to sighted readers.
  const [showsTable, setShowsTable] = useState(false)
  const max = Math.max(0, ...rows.map((r) => r.value))
  const min = Math.min(0, ...rows.map((r) => r.value))
  // A value's distance from the top of the plot, in percent; zero sits at the bottom unless a value is negative.
  const fromTop = (value: number) => (max > min ? ((max - value) / (max - min)) * 100 : 100)
  const zero = fromTop(0)
  const localPeak = rows.reduce<BarChartRow | null>((best, r) => (best === null || r.value > best.value ? r : best), null)
  const peak = serverPeak ?? (localPeak && { label: localPeak.title ?? localPeak.label, display: shown(localPeak) })
  const labelEvery = rows.length <= 12
  const first = rows[0]
  const last = rows[rows.length - 1]
  return (
    <figure className="flex min-w-0 flex-col gap-1.5" data-chart={id}>
      <figcaption className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-text">{title}</span>
        <span className="flex items-center gap-2">
          {controls}
          <span className="tabular-nums text-muted">{m.insights_chart_max({ value: maxDisplay ?? format(max) })}</span>
        </span>
      </figcaption>
      <div role="img" aria-label={peak ? `${title}: ${m.insights_chart_peak({ label: peak.label, value: peak.display })}` : title} className="relative h-28 border-b border-border">
        <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-border-subtle" />
        {min < 0 && <div aria-hidden="true" className="absolute inset-x-0 border-t border-border" style={{ top: `${String(zero)}%` }} />}
        <div className="flex h-full gap-px">
          {rows.map((r) => {
            const height = r.value === 0 ? 0 : Math.max(2, Math.abs(zero - fromTop(r.value)))
            return (
              <div key={r.label} className="relative h-full min-w-0 flex-1" title={`${r.title ?? r.label}: ${shown(r)}`}>
                {variant === 'bar' && <div className={`absolute inset-x-0 mx-auto w-full max-w-6 bg-accent ${r.value < 0 ? 'rounded-b' : 'rounded-t'}`} style={{ top: `${String(r.value < 0 ? zero : zero - height)}%`, height: `${String(height)}%` }} />}
              </div>
            )
          })}
        </div>
        {variant === 'line' && <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-accent" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" points={rows.map((r, i) => `${String(((i + 0.5) / rows.length) * 100)},${String(fromTop(r.value))}`).join(' ')} />
        </svg>}
      </div>
      <div aria-hidden="true" className="flex gap-px text-xs text-muted">
        {labelEvery
          ? rows.map((r) => <span key={r.label} className="min-w-0 flex-1 truncate text-center">{r.label}</span>)
          : <><span className="flex-1">{first?.label}</span><span className="flex-1 text-right">{last?.label}</span></>}
      </div>
      <button type="button" aria-expanded={showsTable} aria-controls={tableId} onClick={() => setShowsTable((v) => !v)} className="self-start text-xs text-muted hover:text-text">{m.insights_chart_table()}</button>
      <table id={tableId} className={showsTable ? 'mt-1 w-full text-xs tabular-nums' : 'sr-only'}>
        <caption className="sr-only">{title}</caption>
        <tbody>{rows.map((r) => <tr key={r.label} className="border-t border-border-subtle"><th scope="row" className="py-0.5 text-left font-normal text-muted">{r.title ?? r.label}</th><td className="py-0.5 text-right text-text">{shown(r)}</td></tr>)}</tbody>
      </table>
    </figure>
  )
}
