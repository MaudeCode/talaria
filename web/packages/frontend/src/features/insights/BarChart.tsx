import { useId, useState, type ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'

export interface BarChartRow { label: string; value: number; /** Longer label for the hover title and the table; defaults to `label`. */ title?: string }

/**
 * One series of bars on a baseline: a y-max label, each bar's value on hover, x labels under every bar when they fit
 * (else first and last), and the table twin behind a disclosure. One hue; the title says what is plotted.
 */
export function BarChart({ title, rows, format, controls, id }: { title: string; rows: BarChartRow[]; format: (value: number) => string; controls?: ReactNode; id: string }) {
  const tableId = useId()
  // The table twin is always in the tree for assistive technology; the toggle only reveals it to sighted readers.
  const [showsTable, setShowsTable] = useState(false)
  const max = Math.max(0, ...rows.map((r) => r.value))
  const peak = rows.reduce<BarChartRow | null>((best, r) => (best === null || r.value > best.value ? r : best), null)
  const labelEvery = rows.length <= 12
  const first = rows[0]
  const last = rows[rows.length - 1]
  return (
    <figure className="flex min-w-0 flex-col gap-1.5" data-chart={id}>
      <figcaption className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-text">{title}</span>
        <span className="flex items-center gap-2">
          {controls}
          <span className="tabular-nums text-muted">{m.insights_chart_max({ value: format(max) })}</span>
        </span>
      </figcaption>
      <div role="img" aria-label={peak ? `${title}: ${m.insights_chart_peak({ label: peak.title ?? peak.label, value: format(peak.value) })}` : title} className="relative h-28 border-b border-border">
        <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-border-subtle" />
        <div className="flex h-full items-end gap-px">
          {rows.map((r) => (
            <div key={r.label} className="flex h-full min-w-0 flex-1 items-end justify-center" title={`${r.title ?? r.label}: ${format(r.value)}`}>
              <div className="w-full max-w-6 rounded-t bg-accent" style={{ height: `${String(max > 0 ? Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100) : 0)}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div aria-hidden="true" className="flex gap-px text-xs text-muted">
        {labelEvery
          ? rows.map((r) => <span key={r.label} className="min-w-0 flex-1 truncate text-center">{r.label}</span>)
          : <><span className="flex-1">{first?.label}</span><span className="flex-1 text-right">{last?.label}</span></>}
      </div>
      <button type="button" aria-expanded={showsTable} aria-controls={tableId} onClick={() => setShowsTable((v) => !v)} className="self-start text-xs text-muted hover:text-text">{m.insights_chart_table()}</button>
      <table id={tableId} className={showsTable ? 'mt-1 w-full text-xs tabular-nums' : 'sr-only'}>
        <caption className="sr-only">{title}</caption>
        <tbody>{rows.map((r) => <tr key={r.label} className="border-t border-border-subtle"><th scope="row" className="py-0.5 text-left font-normal text-muted">{r.title ?? r.label}</th><td className="py-0.5 text-right text-text">{format(r.value)}</td></tr>)}</tbody>
      </table>
    </figure>
  )
}
